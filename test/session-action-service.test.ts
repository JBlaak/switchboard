import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_FIX_LOG_TAIL_LINES, LOG_TAIL_LINES, SessionActionService, type ActionContext,
} from '../src/application/services/session-action-service';
import { NOT_RUNNING_REASON } from '../src/domain/session-work/actions';
import { silentLog } from './support/fakes';
import { FakePrompter, MemoryStore } from './support/session-work-fakes';
import type { PullRequestStatus, SessionWorkItem } from '../src/domain/session-work/model';

const REPO = 'o/app';
const ROOT = '/code/app';
const AGENT = '/code/app/.claude/worktrees/agent-1';

function prItem(number: number, extra: Partial<PullRequestStatus> = {}): SessionWorkItem {
  const url = `https://github.com/${REPO}/pull/${number}`;
  return {
    id: 'pr:' + url,
    kind: 'pr',
    pr: {
      number, url, repository: REPO, state: 'open', baseRef: 'main', headRef: 'feat/' + number,
      headSha: 'sha' + number, checks: [{ name: 'test', state: 'passing' }], closes: [], ...extra,
    },
    location: { worktree: AGENT, branch: 'feat/' + number, fromSubagent: true },
    diff: { kind: 'local', worktree: AGENT, base: 'origin/main', head: 'feat/' + number },
    activity: null,
  };
}

const branchItem: SessionWorkItem = {
  id: 'branch:' + AGENT + '\0spike',
  kind: 'branch',
  location: { worktree: AGENT, branch: 'spike', fromSubagent: true },
  ahead: 2,
  diff: { kind: 'local', worktree: AGENT, base: 'origin/main', head: 'spike' },
  activity: null,
  additions: 1,
  deletions: 0,
  pushed: false,
};

const dirtyItem: SessionWorkItem = {
  id: 'dirty:' + ROOT + '\0main',
  kind: 'dirty',
  location: { worktree: ROOT, branch: 'main', fromSubagent: false },
  files: [{ path: 'a.ts', status: 'modified' }],
  activity: null,
  additions: 1,
  deletions: 0,
};

function setup({ items = [prItem(12), prItem(13), branchItem], store = new MemoryStore(), prompter = new FakePrompter() } = {}) {
  const page = new Map(items.map((item) => [item.id, item]));
  const context: ActionContext = { repository: REPO, mainCheckout: ROOT, gh: 'ok' };
  const changed: string[] = [];
  const logRequests: Array<[string, string, number]> = [];
  let seq = 0;
  let now = Date.UTC(2026, 9, 17, 12, 0, 0);
  const service = new SessionActionService({
    prompter,
    store,
    github: {
      async checkLogTail(repo, url, lines) {
        logRequests.push([repo, url, lines]);
        return 'Error: expected 2, got 3';
      },
    },
    ids: { newId: () => 'a' + ++seq },
    clock: { now: () => (now += 1000) },
    log: silentLog,
  });
  service.attach({
    item: (sessionId, itemId) => (sessionId === 's1' ? page.get(itemId) ?? null : null),
    context: (sessionId) => (sessionId === 's1' ? context : null),
    activitiesChanged: (sessionId) => changed.push(sessionId),
  });
  return { service, prompter, store, page, context, changed, logRequests };
}

const PR12 = prItem(12).id;
const PR13 = prItem(13).id;

test('an idle session gets the prompt at once, and the action is with Claude', async () => {
  /* Given */
  const { service, prompter, store, changed } = setup();

  /* When */
  const result = await service.request('s1', PR12, 'ship');

  /* Then */
  assert.deepEqual(result, { ok: true, activityId: 'a1' });
  assert.equal(prompter.sent.length, 1);
  assert.match(prompter.sent[0].prompt, /^Ship PR #12 \(https:\/\/github.com\/o\/app\/pull\/12\)\./);
  assert.match(prompter.sent[0].prompt, /gh pr merge 12 --merge --delete-branch, remove the worktree \/code\/app\/\.claude\/worktrees\/agent-1/);
  assert.match(prompter.sent[0].prompt, /pull main in \/code\/app\.$/);
  assert.equal(store.rows[0].phase, 'sent');
  assert.equal(store.rows[0].repository, REPO);
  assert.equal(store.rows[0].itemKey, PR12);
  assert.equal(store.rows[0].origin, 'manual');
  const activity = service.forSession('s1').byItem.get(PR12);
  assert.equal(activity?.phase, 'sent');
  assert.equal(activity?.id, 'a1');
  assert.ok(activity?.sentAt);
  assert.ok(changed.length >= 1, 'the page heard about it');
});

test('Ship it merges with the repository\'s method', async () => {
  /* Given */
  const { service, prompter } = setup({ items: [prItem(12, { mergeMethod: 'squash' })] });

  /* When */
  await service.request('s1', PR12, 'ship');

  /* Then */
  assert.match(prompter.sent[0].prompt, /gh pr merge 12 --squash --delete-branch/);
});

test('uncommitted changes hand Claude a commit-and-PR prompt for their worktree', async () => {
  const { service, prompter } = setup({ items: [dirtyItem] });
  await service.request('s1', dirtyItem.id, 'create-pr');
  assert.equal(prompter.sent[0].prompt,
    `Commit the uncommitted changes in ${ROOT}, on a new branch if main is the default branch, ` +
    "then push it and open a pull request for it, following this repo's commit and PR conventions.");
});

test('while the session is busy, actions queue in order and go in one per turn', async () => {
  /* Given */
  const { service, prompter, store } = setup();
  prompter.goBusy();

  /* When */
  await service.request('s1', PR12, 'ship');
  await service.request('s1', PR13, 'ship');
  await service.request('s1', branchItem.id, 'open-pr');

  /* Then */
  assert.equal(prompter.sent.length, 0);
  assert.deepEqual(store.rows.map((r) => r.phase), ['queued', 'queued', 'queued']);
  assert.equal(service.forSession('s1').queued, 3);

  /* When */
  // The turn ends: the first goes in, and only the first.
  prompter.goIdle();

  /* Then */
  assert.deepEqual(prompter.sent.map((s) => s.prompt.slice(0, 12)), ['Ship PR #12 ']);
  assert.equal(service.forSession('s1').queued, 2);

  /* When */
  // Claude works on it, and finishes: it is done, and the next goes in.
  prompter.goBusy();
  prompter.goIdle();

  /* Then */
  assert.deepEqual(store.rows.map((r) => r.phase), ['done', 'sent', 'queued']);
  assert.ok(store.rows[0].doneAt);

  /* When */
  prompter.goBusy();
  prompter.goIdle();

  /* Then */
  assert.deepEqual(prompter.sent.map((s) => s.prompt.slice(0, 12)), ['Ship PR #12 ', 'Ship PR #13 ', 'Push spike f']);

  /* When */
  prompter.goBusy();
  prompter.goIdle();

  /* Then */
  assert.deepEqual(store.rows.map((r) => r.phase), ['done', 'done', 'done']);
  assert.equal(prompter.listenerCount(), 0, 'nothing left to wait for');
});

test('each prompt is typed in exactly once, however many idles follow', async () => {
  /* Given */
  const { service, prompter } = setup();
  prompter.goBusy();
  await service.request('s1', PR12, 'ship');

  /* When */
  prompter.goIdle();
  prompter.goIdle();
  prompter.goIdle();

  /* Then */
  assert.equal(prompter.sent.length, 1);
});

/** A busy session with PR 12 and PR 13 queued for Ship it. */
async function twoQueued() {
  const h = setup();
  h.prompter.goBusy();
  const first = await h.service.request('s1', PR12, 'ship');
  const second = await h.service.request('s1', PR13, 'ship');
  const idOf = (result: typeof first) => ('activityId' in result ? result.activityId : '');
  return { ...h, queuedOk: first.ok && second.ok, first: idOf(first), second: idOf(second) };
}

test('cancel takes out a queued action', async () => {
  /* Given */
  const { service, prompter, store, queuedOk, first, second } = await twoQueued();

  /* When */
  const result = service.cancel(second);

  /* Then */
  assert.ok(queuedOk);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(store.rows.map((r) => r.id), [first]);
  assert.equal(service.forSession('s1').byItem.get(PR13), undefined);

  /* When */
  prompter.goIdle();

  /* Then */
  assert.equal(prompter.sent.length, 1, 'the cancelled one never goes in');
});

test('cancel leaves an action already with Claude alone', async () => {
  /* Given */
  const { service, prompter, first } = await twoQueued();
  prompter.goIdle();

  /* When */
  const result = service.cancel(first);

  /* Then */
  assert.deepEqual(result, { ok: false, reason: 'It was already handed to Claude' });
});

test('cancel of an unknown id is refused', async () => {
  /* Given */
  const { service } = await twoQueued();

  /* When */
  const result = service.cancel('nope');

  /* Then */
  assert.deepEqual(result, { ok: false, reason: 'Nothing is queued by that id' });
});

test('a session that is not running is refused, and nothing is stored', async () => {
  /* Given */
  const { service, prompter, store } = setup();
  prompter.running.clear();

  /* When */
  const result = await service.request('s1', PR12, 'ship');

  /* Then */
  assert.deepEqual(result, { ok: false, reason: NOT_RUNNING_REASON });
  assert.deepEqual(store.rows, []);
  assert.deepEqual(prompter.sent, []);
});

test('refused: an item not on the page', async () => {
  /* Given */
  const { service } = setup();

  /* When */
  const result = await service.request('s1', 'pr:gone', 'ship');

  /* Then */
  assert.equal(result.ok, false);
});

test('refused: an action the item does not offer', async () => {
  /* Given */
  const { service } = setup();

  /* When */
  const rebase = await service.request('s1', PR12, 'rebase');
  const shipBranch = await service.request('s1', branchItem.id, 'ship');

  /* Then */
  assert.deepEqual(rebase, { ok: false, reason: 'This item has nothing for that action to do' });
  assert.deepEqual(shipBranch, { ok: false, reason: 'This item has nothing for that action to do' });
});

test('refused: the same action twice, queued or with Claude', async () => {
  /* Given */
  const { service, prompter } = setup();
  prompter.goBusy();

  /* When */
  const first = await service.request('s1', PR12, 'ship');
  const again = await service.request('s1', PR12, 'ship');

  /* Then */
  assert.ok(first.ok);
  assert.deepEqual(again, { ok: false, reason: 'Already queued' });

  /* When */
  prompter.goIdle();
  const whileSent = await service.request('s1', PR12, 'ship');

  /* Then */
  assert.deepEqual(whileSent, { ok: false, reason: 'Claude is already on it' });
});

test('without gh, nothing is offered', async () => {
  /* Given */
  const { service, context } = setup();
  context.gh = 'missing';

  /* When */
  const result = await service.request('s1', PR12, 'ship');

  /* Then */
  assert.equal(result.ok, false);
});

test('Fix CI carries the failing check, its commit and the end of its log', async () => {
  /* Given */
  const failing = prItem(12, { checks: [{ name: 'lint', state: 'passing' }, { name: 'test', state: 'failing', url: 'https://github.com/o/app/actions/runs/1/job/2' }] });
  const { service, prompter, logRequests } = setup({ items: [failing] });

  /* When */
  const result = await service.request('s1', PR12, 'fix-ci');

  /* Then */
  assert.ok(result.ok);
  assert.deepEqual(logRequests, [[REPO, 'https://github.com/o/app/actions/runs/1/job/2', LOG_TAIL_LINES]]);
  assert.equal(prompter.sent[0].prompt,
    'CI is failing on PR #12 (https://github.com/o/app/pull/12): test failed on sha12. Log tail:\n' +
    'Error: expected 2, got 3\nFix it in /code/app/.claude/worktrees/agent-1 and push.');
});

test('Fix comments hands over the open threads, Rebase the head and base, Open PR the branch', async () => {
  /* Given */
  const thread = (id: string, resolved: boolean) => ({
    id, path: 'a.ts', line: 3, side: 'RIGHT' as const, resolved,
    comments: [{ author: 'mate', isBot: false, body: 'rename this', createdAt: '' }],
  });
  const pr = prItem(12, { behindBy: 2, threads: [thread('T1', false), thread('T2', true)] });
  const { service, prompter } = setup({ items: [pr, branchItem] });
  prompter.goBusy();

  /* When */
  await service.request('s1', PR12, 'fix-comments');
  await service.request('s1', PR12, 'rebase');
  await service.request('s1', branchItem.id, 'open-pr');
  for (let i = 0; i < 3; i++) { prompter.goIdle(); prompter.goBusy(); }

  /* Then */
  const [fix, rebase, open] = prompter.sent.map((s) => s.prompt);
  assert.match(fix, /^Address the open review threads on PR #12/);
  assert.match(fix, /a\.ts:3 — mate: rename this \(T1\)/);
  assert.doesNotMatch(fix, /T2/);
  assert.equal(rebase, 'Rebase PR #12 (feat/12) onto origin/main and force-push with lease. ' +
    'Resolve conflicts if there are any; if a conflict needs a decision from me, stop and ask.');
  assert.equal(open, `Push spike from ${AGENT} and open a pull request for it against main, following this repo's PR conventions.`);
});

test('the item card shows the action with Claude, else the next one waiting', async () => {
  /* Given */
  const pr = prItem(12, { behindBy: 1 });
  const { service, prompter } = setup({ items: [pr] });
  prompter.goBusy();

  /* When */
  await service.request('s1', PR12, 'rebase');
  await service.request('s1', PR12, 'ship');

  /* Then */
  assert.equal(service.forSession('s1').byItem.get(PR12)?.action, 'rebase');
  assert.equal(service.forSession('s1').byItem.get(PR12)?.phase, 'queued');
  assert.equal(service.forSession('s1').shipping, true);

  /* When */
  prompter.goIdle();

  /* Then */
  assert.equal(service.forSession('s1').byItem.get(PR12)?.phase, 'sent');

  /* When */
  prompter.goBusy();
  prompter.goIdle();

  /* Then */
  assert.equal(service.forSession('s1').byItem.get(PR12)?.action, 'ship');

  /* When */
  prompter.goBusy();
  prompter.goIdle();

  /* Then */
  assert.equal(service.forSession('s1').byItem.get(PR12), undefined, 'done shows nothing');
  assert.equal(service.forSession('s1').shipping, false);
});

test('after a restart the queue resumes once its session is running and idle; what was sent is done', async () => {
  /* Given */
  const store = new MemoryStore();
  const before = setup({ store });
  before.prompter.goBusy();
  await before.service.request('s1', PR12, 'ship');
  before.prompter.goIdle();
  await before.service.request('s1', PR13, 'ship');
  before.prompter.goBusy();
  await before.service.request('s1', branchItem.id, 'open-pr');
  const phasesBefore = store.rows.map((r) => r.phase);
  // The app quits with the session; it comes back without it.
  const prompter = new FakePrompter();
  prompter.running.clear();

  /* When */
  const after = setup({ store, prompter });

  /* Then */
  assert.deepEqual(phasesBefore, ['sent', 'queued', 'queued']);
  assert.deepEqual(store.rows.map((r) => r.phase), ['done', 'queued', 'queued']);
  assert.equal(after.service.forSession('s1').queued, 2);
  assert.equal(prompter.sent.length, 0);

  /* When */
  // The session is started again and comes to its prompt.
  prompter.running.add('s1');
  prompter.goIdle();

  /* Then */
  assert.deepEqual(prompter.sent.map((s) => s.prompt.slice(0, 12)), ['Ship PR #13 ']);

  /* When */
  prompter.goBusy();
  prompter.goIdle();

  /* Then */
  assert.deepEqual(prompter.sent.map((s) => s.prompt.slice(0, 12)), ['Ship PR #13 ', 'Push spike f']);
});

test('a session that moved to a new id keeps its queue', async () => {
  /* Given */
  const { service, prompter } = setup();
  prompter.goBusy();
  await service.request('s1', PR12, 'ship');

  /* When */
  // A plan was accepted: s1 is s2 now.
  prompter.running = new Set(['s2']);
  prompter.busy = new Set(['s2']);
  prompter.moved.set('s1', 's2');

  /* Then */
  assert.equal(service.forSession('s2').queued, 1);

  /* When */
  prompter.goIdle('s2');

  /* Then */
  assert.equal(prompter.sent.length, 1);
  assert.equal(service.forSession('s2').byItem.get(PR12)?.phase, 'sent');
});

// ── Fix comments on named threads (#77) ──

function reviewThread(id: string, resolved = false) {
  return {
    id, path: 'a.ts', line: 3, side: 'RIGHT' as const, resolved,
    comments: [{ author: 'mate', isBot: false, body: 'fix ' + id, createdAt: '' }],
  };
}

test('Fix comments on named threads hands over exactly those, and the activity names them', async () => {
  /* Given */
  const pr = prItem(12, { threads: [reviewThread('T1'), reviewThread('T2'), reviewThread('T3'), reviewThread('T4', true)] });
  const { service, prompter } = setup({ items: [pr] });

  /* When */
  const result = await service.request('s1', PR12, 'fix-comments', 'manual', { threadIds: ['T2', 'T4'] });

  /* Then */
  assert.equal(result.ok, true);
  const prompt = prompter.sent[0].prompt;
  assert.match(prompt, /\(T2\)/);
  assert.doesNotMatch(prompt, /\(T1\)|\(T3\)|\(T4\)/, 'only the named open threads');
  assert.deepEqual(service.forSession('s1').byItem.get(PR12)?.threadIds, ['T2']);
  assert.deepEqual(service.forSession('s1').fixingThreads?.get(PR12), ['T2']);
});

test('another thread can be handed over while one is with Claude; the same one cannot', async () => {
  /* Given */
  const pr = prItem(12, { threads: [reviewThread('T1'), reviewThread('T2')] });
  const { service, prompter } = setup({ items: [pr] });
  prompter.goBusy();
  const first = await service.request('s1', PR12, 'fix-comments', 'manual', { threadIds: ['T1'] });

  /* When */
  const same = await service.request('s1', PR12, 'fix-comments', 'manual', { threadIds: ['T1'] });
  const second = await service.request('s1', PR12, 'fix-comments', 'manual', { threadIds: ['T2'] });

  /* Then */
  assert.equal(first.ok, true);
  assert.deepEqual(same, { ok: false, reason: 'Already queued' });
  assert.ok(second.ok);
  // In flight like any action, and the item's current one: the CI watch stays out of its way.
  assert.equal(service.isInFlight(second.activityId), true);
  assert.equal(service.forSession('s1').byItem.get(PR12)?.action, 'fix-comments');
  assert.deepEqual(service.forSession('s1').fixingThreads?.get(PR12), ['T1', 'T2']);

  /* When */
  // Every open thread without naming them: one is already queued.
  const every = await service.request('s1', PR12, 'fix-comments');

  /* Then */
  assert.equal(every.ok, false);
});

const twoThreads = () => setup({ items: [prItem(12, { threads: [reviewThread('T1'), reviewThread('T2', true)] })] });

test('naming no thread is not "every thread"', async () => {
  /* Given */
  const { service, prompter } = twoThreads();

  /* When */
  const none = await service.request('s1', PR12, 'fix-comments', 'manual', { threadIds: [] });

  /* Then */
  assert.equal(none.ok, false, 'naming no thread is not "every thread"');
  assert.equal(prompter.sent.length, 0);
});

test('naming only resolved or unknown threads has nothing to do', async () => {
  /* Given */
  const { service, prompter } = twoThreads();

  /* When */
  const result = await service.request('s1', PR12, 'fix-comments', 'manual', { threadIds: ['T2', 'nope'] });

  /* Then */
  assert.equal(result.ok, false);
  assert.equal(prompter.sent.length, 0);
});

test('a queued Fix comments still knows its threads after a restart', async () => {
  /* Given */
  const pr = prItem(12, { threads: [reviewThread('T1'), reviewThread('T2')] });
  const store = new MemoryStore();
  const first = setup({ items: [pr], store });
  first.prompter.goBusy();
  await first.service.request('s1', PR12, 'fix-comments', 'manual', { threadIds: ['T2'] });

  /* When */
  const again = setup({ items: [pr], store });

  /* Then */
  assert.deepEqual(again.service.forSession('s1').fixingThreads?.get(PR12), ['T2']);
});

test('a session that exits while Claude has an action finishes it; what is queued waits for the next start', async () => {
  /* Given */
  const { service, prompter, store } = setup();
  await service.request('s1', PR12, 'ship');
  prompter.goBusy();
  await service.request('s1', PR13, 'ship');
  const phasesBefore = store.rows.map((r) => r.phase);

  /* When */
  prompter.exit();

  /* Then */
  assert.deepEqual(phasesBefore, ['sent', 'queued']);
  assert.deepEqual(store.rows.map((r) => r.phase), ['done', 'queued']);
  assert.equal(service.forSession('s1').byItem.get(PR12), undefined, 'no longer amber');
  assert.equal(prompter.sent.length, 1, 'nothing typed into a session that is not running');

  /* When */
  // Resumed later: the queue goes on once it is at its prompt.
  prompter.running.add('s1');
  prompter.goIdle();

  /* Then */
  assert.deepEqual(prompter.sent.map((sent) => sent.prompt.slice(0, 12)), ['Ship PR #12 ', 'Ship PR #13 ']);
});

test('without the page open, an item handed in can be asked for: an automatic Fix CI', async () => {
  /* Given */
  const { service, prompter, store, logRequests, context } = setup({ items: [] });
  const item = prItem(12, {
    headSha: 'abc1234', checks: [{ name: 'lint', state: 'failing', url: 'https://github.com/o/app/runs/1' },
      { name: 'test', state: 'failing', url: 'https://github.com/o/app/runs/2' }],
  });

  /* When */
  const result = await service.request('s1', item.id, 'fix-ci', 'auto', { resolved: { item, context, checkName: 'test', attempt: 1 } });

  /* Then */
  assert.equal(result.ok, true);
  assert.deepEqual(logRequests, [[REPO, 'https://github.com/o/app/runs/2', AUTO_FIX_LOG_TAIL_LINES]]);
  assert.match(prompter.sent[0].prompt, /: test failed on abc1234\. Log tail:\nError: expected 2, got 3\n/);
  assert.match(prompter.sent[0].prompt, /This is automatic attempt 1 of 2\.$/);
  assert.equal(store.rows[0].origin, 'auto');
  const activity = service.forSession('s1').byItem.get(item.id);
  assert.equal(activity?.attempt, 1);
  assert.equal(activity?.checkName, 'test');
  assert.equal(service.isInFlight(store.rows[0].id), true);

  /* When */
  prompter.goBusy();
  prompter.goIdle();

  /* Then */
  assert.equal(service.isInFlight(store.rows[0].id), false);
});

test('a manual Fix CI carries the shorter log and no attempt', async () => {
  /* Given */
  const { service, logRequests, store } = setup({
    items: [prItem(12, { checks: [{ name: 'test', state: 'failing', url: 'https://github.com/o/app/runs/2' }] })],
  });

  /* When */
  await service.request('s1', PR12, 'fix-ci');

  /* Then */
  assert.equal(logRequests[0][2], LOG_TAIL_LINES);
  assert.deepEqual(store.rows[0].details, { checkName: 'test' });
});

const attempts = [{ attempt: 1, failedOn: 'aaa', pushed: 'bbb' }, { attempt: 2, failedOn: 'bbb', pushed: null }];

/** A store holding a Fix CI given up on for PR 12's test check, and the app restarted on it. */
function gaveUpThenRestarted() {
  const store = new MemoryStore();
  setup({ store }).service.giveUp('s1', PR12, REPO, { checkName: 'test', attempts });
  return { store, after: setup({ store }) };
}

test('giving up shows red', () => {
  /* Given */
  const { service, changed } = setup();

  /* When */
  service.giveUp('s1', PR12, REPO, { checkName: 'test', attempts });

  /* Then */
  const card = service.forSession('s1').byItem.get(PR12);
  assert.equal(card?.phase, 'gave-up');
  assert.equal(card?.origin, 'auto');
  assert.deepEqual(card?.attempts, attempts);
  assert.ok(changed.length > 0);
});

test('giving up survives a restart', () => {
  /* When */
  const { after } = gaveUpThenRestarted();

  /* Then */
  assert.deepEqual(after.service.forSession('s1').byItem.get(PR12)?.attempts, attempts);
});

test('giving up shows red while another check goes green', () => {
  /* Given */
  const { after } = gaveUpThenRestarted();

  /* When */
  after.service.settleGaveUp('s1', PR12, 'lint');

  /* Then */
  assert.equal(after.service.forSession('s1').byItem.get(PR12)?.phase, 'gave-up', 'another check going green changes nothing');
});

test('giving up is settled once the check is green again', () => {
  /* Given */
  const { store, after } = gaveUpThenRestarted();

  /* When */
  after.service.settleGaveUp('s1', PR12, 'test');

  /* Then */
  assert.equal(after.service.forSession('s1').byItem.get(PR12), undefined);
  assert.equal(store.rows[0].phase, 'done');
});
