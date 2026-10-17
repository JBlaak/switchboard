import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PrWatchService, type WatchedSession } from '../src/application/services/pr-watch-service';
import { AUTO_FIX_LOG_TAIL_LINES, SessionActionService } from '../src/application/services/session-action-service';
import { fakeRenderer, fakeTimers, silentLog } from './support/fakes';
import { FakePrompter, MemoryStore } from './support/session-work-fakes';
import type { AutoFixHistory, AutoFixRecord } from '../src/application/ports/auto-fix-history';
import type { GitHubAvailability } from '../src/application/ports/github-cli';
import type { CheckRun, PullRequestStatus } from '../src/domain/session-work/model';
import type { PullRequestStatusChange } from '../src/domain/session-work/status';

const REPO = 'o/app';
const ROOT = '/code/app';
const AGENT = '/code/app/.claude/worktrees/agent-1';
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const KEY7 = 'pr:' + url(7);
const RUN = 'https://github.com/o/app/actions/runs/1/job/2';

function status(headSha: string, state: CheckRun['state'], more: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 7, url: url(7), repository: REPO, state: 'open', headSha, headRef: 'feat/7', baseRef: 'main',
    checks: [{ name: 'build', state: 'passing' }, { name: 'test', state, url: RUN }], closes: [], ...more,
  };
}

/** `gh`, answering from a table the test edits between polls. */
class FakeGitHub {
  availability: GitHubAvailability = 'ok';
  prs = new Map<number, PullRequestStatus>();
  calls: Array<[string, number[]]> = [];
  logs: Array<[string, string, number]> = [];
  async available() { return this.availability; }
  /** While set, every answer waits for it: an answer still on its way. */
  gate: Promise<void> | null = null;
  async pullRequests(repo: string, numbers: readonly number[]) {
    this.calls.push([repo, [...numbers]]);
    if (this.gate) await this.gate;
    return numbers.flatMap((n) => (this.prs.has(n) ? [{ ...this.prs.get(n)! }] : []));
  }
  async checkLogTail(repo: string, checkRunUrl: string, lines: number) {
    this.logs.push([repo, checkRunUrl, lines]);
    return 'FAIL src/login.test.ts\nexpected 2, got 3';
  }
}

class MemoryHistory implements AutoFixHistory {
  rows: AutoFixRecord[] = [];
  record(event: AutoFixRecord) { this.rows.push({ ...event }); }
  forPullRequest(repository: string, number: number) {
    return this.rows.filter((row) => row.repository === repository && row.number === number).map((row) => ({ ...row }));
  }
}

const SESSION: WatchedSession = {
  sessionId: 's1', projectPath: ROOT, folder: '-code-app',
  pullRequests: [{ number: 7, url: url(7), repository: REPO }],
};

function setup({
  history = new MemoryHistory(), store = new MemoryStore(), prompter = new FakePrompter(), github = new FakeGitHub(),
  sessions = [SESSION],
} = {}) {
  const renderer = fakeRenderer();
  let seq = 0;
  let now = Date.UTC(2026, 9, 17, 12, 0, 0);
  const clock = { now: () => (now += 1000) };
  const actions = new SessionActionService({
    prompter, store, github, ids: { newId: () => 'a' + ++seq + '-' + store.rows.length }, clock, log: silentLog,
  });
  const timers = fakeTimers();
  const watch = new PrWatchService({
    // Only running sessions are watched, as the registry would say.
    sessions: () => sessions.filter((session) => prompter.runningId(session.sessionId) !== null),
    github,
    history,
    actions,
    transcripts: {
      locations: () => [
        { cwd: ROOT, branch: 'main', fromSubagent: false },
        { cwd: AGENT + '/src', branch: 'feat/7', fromSubagent: true },
      ],
    },
    git: { worktreeRoot: async (cwd: string) => (cwd.startsWith(AGENT) ? AGENT : ROOT) },
    renderer, clock, timers, log: silentLog,
  });
  const dots = () => renderer.only('prStatusChanged').map((event) => event[1] as PullRequestStatusChange);
  /** Claude takes a turn on what was typed in, and comes back to its prompt. */
  const finishTurn = () => {
    prompter.goBusy();
    prompter.goIdle();
  };
  return { watch, actions, prompter, store, history, github, renderer, timers, dots, finishTurn };
}

const attempts = (history: MemoryHistory) =>
  history.rows.filter((row) => row.kind === 'attempt').map((row) => row.kind === 'attempt' && row.headSha);

test('a failing check is handed to the session as automatic attempt 1, with its check, commit and log', async () => {
  const { watch, github, prompter, history, store } = setup();
  github.prs.set(7, status('aaa1111', 'failing'));
  await watch.poll();

  assert.deepEqual(github.calls, [[REPO, [7]]]);
  assert.deepEqual(github.logs, [[REPO, RUN, AUTO_FIX_LOG_TAIL_LINES]]);
  assert.equal(prompter.sent.length, 1);
  const prompt = prompter.sent[0].prompt;
  assert.match(prompt, /^CI is failing on PR #7 \(https:\/\/github.com\/o\/app\/pull\/7\): test failed on aaa1111\. Log tail:\n/);
  assert.match(prompt, /expected 2, got 3\nFix it in \/code\/app\/\.claude\/worktrees\/agent-1 and push\./);
  assert.match(prompt, /This is automatic attempt 1 of 2\.$/);
  assert.equal(store.rows[0].origin, 'auto');
  assert.equal(store.rows[0].itemKey, KEY7);
  assert.deepEqual(history.rows.map((row) => row.kind), ['attempt']);
  assert.equal(history.rows[0].kind === 'attempt' && history.rows[0].activityId, store.rows[0].id);
});

test('one gh request per repository, however many sessions and PRs', async () => {
  const github = new FakeGitHub();
  const prompter = new FakePrompter();
  prompter.running.add('s2');
  const other: WatchedSession = {
    sessionId: 's2', projectPath: ROOT, folder: '-code-app',
    pullRequests: [{ number: 8, url: url(8), repository: '' }, { number: 7, url: url(7), repository: REPO }],
  };
  const { watch } = setup({ github, prompter, sessions: [SESSION, other] });
  github.prs.set(7, status('aaa', 'passing'));
  github.prs.set(8, status('bbb', 'passing', { number: 8, url: url(8) }));
  await watch.poll();
  assert.deepEqual(github.calls, [[REPO, [7, 8]]]);
});

test('while Claude has the attempt, the same red check is left alone', async () => {
  const { watch, github, prompter, history } = setup();
  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  await watch.poll();
  // Claude pushed mid-turn and the new commit failed too: still its turn.
  github.prs.set(7, status('bbb', 'failing'));
  await watch.poll();
  assert.equal(prompter.sent.length, 1);
  assert.deepEqual(attempts(history), ['aaa']);
});

test('a new failing commit is attempt 2, and the next failure gives up: Needs you, and the row says so', async () => {
  const { watch, github, prompter, history, actions, renderer, dots, finishTurn } = setup();
  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  finishTurn();

  github.prs.set(7, status('bbb', 'failing'));
  await watch.poll();
  assert.equal(prompter.sent.length, 2);
  assert.match(prompter.sent[1].prompt, /test failed on bbb\..*This is automatic attempt 2 of 2\.$/s);
  finishTurn();

  github.prs.set(7, status('ccc', 'failing'));
  await watch.poll();
  assert.equal(prompter.sent.length, 2, 'nothing more is typed in');
  const card = actions.forSession('s1').byItem.get(KEY7);
  assert.equal(card?.phase, 'gave-up');
  assert.equal(card?.checkName, 'test');
  assert.deepEqual(card?.attempts, [
    { attempt: 1, failedOn: 'aaa', pushed: 'bbb' },
    { attempt: 2, failedOn: 'bbb', pushed: 'ccc' },
  ]);
  assert.deepEqual(renderer.only('sessionNeedsAttention'), [['sessionNeedsAttention', 's1']]);
  assert.deepEqual(dots().at(-1), { sessionId: 's1', prs: [{ number: 7, dot: 'red' }], needsYou: true });

  // Given up once: the next poll does not give up again.
  await watch.poll();
  assert.equal(renderer.only('sessionNeedsAttention').length, 1);
  assert.deepEqual(history.rows.map((row) => row.kind), ['attempt', 'attempt', 'gave-up']);
});

test('a turn that ended without a push spends the attempt: the same commit still failing is attempt 2', async () => {
  const { watch, github, prompter, history, finishTurn } = setup();
  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  finishTurn();
  await watch.poll();
  assert.equal(prompter.sent.length, 2);
  assert.match(prompter.sent[1].prompt, /automatic attempt 2 of 2\.$/);
  finishTurn();
  await watch.poll();
  assert.deepEqual(attempts(history), ['aaa', 'aaa']);
  assert.deepEqual(history.rows.at(-1)?.kind, 'gave-up');
});

test('green wipes the slate and ends the give-up; a later failure starts again at attempt 1', async () => {
  const { watch, github, prompter, history, actions, dots, finishTurn } = setup();
  for (const sha of ['aaa', 'bbb', 'ccc']) {
    github.prs.set(7, status(sha, 'failing'));
    await watch.poll();
    finishTurn();
  }
  assert.equal(actions.forSession('s1').byItem.get(KEY7)?.phase, 'gave-up');

  github.prs.set(7, status('ddd', 'passing'));
  await watch.poll();
  assert.equal(actions.forSession('s1').byItem.get(KEY7), undefined);
  assert.equal(history.rows.at(-1)?.kind, 'passed');
  assert.deepEqual(dots().at(-1), { sessionId: 's1', prs: [{ number: 7, dot: 'green' }], needsYou: false });
  await watch.poll();
  assert.equal(history.rows.filter((row) => row.kind === 'passed').length, 1, 'green is recorded once');

  github.prs.set(7, status('eee', 'failing'));
  await watch.poll();
  assert.match(prompter.sent.at(-1)!.prompt, /test failed on eee\..*automatic attempt 1 of 2\.$/s);
});

test('a manual Fix CI is always allowed and does not count', async () => {
  const { watch, github, prompter, actions, history, finishTurn } = setup();
  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  finishTurn();
  github.prs.set(7, status('bbb', 'failing'));
  await watch.poll();
  finishTurn();

  // Two automatic attempts spent; you ask for one yourself, from the page.
  github.prs.set(7, status('ccc', 'failing'));
  const pr = status('ccc', 'failing');
  const item = {
    id: KEY7, kind: 'pr' as const, pr, location: null, activity: null,
    diff: { kind: 'pull-request' as const, repository: REPO, number: 7 },
  };
  const manual = await actions.request('s1', KEY7, 'fix-ci', 'manual', {
    resolved: { item, context: { repository: REPO, mainCheckout: ROOT, gh: 'ok' } },
  });
  assert.equal(manual.ok, true);
  assert.equal(prompter.sent.length, 3);
  assert.doesNotMatch(prompter.sent[2].prompt, /automatic attempt/);

  // While it is with Claude, the watch neither queues nor gives up.
  await watch.poll();
  assert.equal(actions.forSession('s1').byItem.get(KEY7)?.phase, 'sent');
  assert.deepEqual(history.rows.map((row) => row.kind), ['attempt', 'attempt']);

  // It did not fix it either: now the PR is yours.
  finishTurn();
  await watch.poll();
  assert.equal(actions.forSession('s1').byItem.get(KEY7)?.phase, 'gave-up');
});

test('a manual Fix CI that did not fix it leaves both automatic attempts', async () => {
  const { watch, github, prompter, actions, finishTurn } = setup();
  const pr = status('aaa', 'failing');
  github.prs.set(7, pr);
  prompter.goBusy();
  const item = {
    id: KEY7, kind: 'pr' as const, pr, location: null, activity: null,
    diff: { kind: 'pull-request' as const, repository: REPO, number: 7 },
  };
  await actions.request('s1', KEY7, 'fix-ci', 'manual', { resolved: { item, context: { repository: REPO, mainCheckout: ROOT, gh: 'ok' } } });
  await watch.poll();
  assert.equal(actions.forSession('s1').queued, 1, 'only yours is queued');
  prompter.goIdle();
  finishTurn();

  await watch.poll();
  assert.match(prompter.sent.at(-1)!.prompt, /automatic attempt 1 of 2\.$/);
});

test('a session that is not running gets nothing; a fix queued while it was busy waits for its next start', async () => {
  const { watch, github, prompter, store } = setup();
  prompter.goBusy();
  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  assert.equal(prompter.sent.length, 0);
  assert.equal(store.rows[0].phase, 'queued');

  prompter.exit();
  github.prs.set(7, status('bbb', 'failing'));
  await watch.poll();
  assert.equal(github.calls.length, 1, 'a stopped session is not watched');
  assert.equal(prompter.sent.length, 0);
  assert.equal(store.rows.length, 1);

  prompter.running.add('s1');
  prompter.goIdle();
  assert.equal(prompter.sent.length, 1);
  assert.match(prompter.sent[0].prompt, /test failed on aaa\./);
});

test('a session that exits mid-fix finishes the action, so the next poll can go on', async () => {
  const { watch, github, prompter, store, history } = setup();
  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  assert.equal(store.rows[0].phase, 'sent');
  prompter.exit();
  assert.equal(store.rows[0].phase, 'done');

  prompter.running.add('s1');
  await watch.poll();
  assert.deepEqual(attempts(history), ['aaa', 'aaa']);
});

test('the history survives a restart: two spent attempts are not handed out again', async () => {
  const history = new MemoryHistory();
  const store = new MemoryStore();
  const before = setup({ history, store });
  for (const sha of ['aaa', 'bbb']) {
    before.github.prs.set(7, status(sha, 'failing'));
    await before.watch.poll();
    before.finishTurn();
  }

  const after = setup({ history, store });
  after.github.prs.set(7, status('ccc', 'failing'));
  await after.watch.poll();
  assert.equal(after.prompter.sent.length, 0);
  assert.equal(after.actions.forSession('s1').byItem.get(KEY7)?.phase, 'gave-up');
});

test('a merged PR ends a give-up and is not asked about again', async () => {
  const { watch, github, dots } = setup();
  github.prs.set(7, status('aaa', 'passing', { state: 'merged' }));
  await watch.poll();
  await watch.poll();
  assert.equal(github.calls.length, 1);
  assert.deepEqual(dots(), [{ sessionId: 's1', prs: [{ number: 7, dot: 'green' }], needsYou: false }]);
});

test('dots are pushed only when they change: amber while Claude fixes it, gone when the session stops', async () => {
  const { watch, github, prompter, dots, finishTurn } = setup();
  github.prs.set(7, status('aaa', 'pending'));
  await watch.poll();
  await watch.poll();
  assert.deepEqual(dots(), [{ sessionId: 's1', prs: [{ number: 7, dot: 'amber' }], needsYou: false }]);

  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  assert.equal(dots().length, 1, 'failing, but Claude is on it: still amber');
  finishTurn();
  assert.equal(dots().length, 1, 'Claude is done, but gh has not said what it pushed: still amber');

  prompter.exit();
  await watch.poll();
  assert.deepEqual(dots().at(-1), { sessionId: 's1', prs: [], needsYou: false });
});

test('the minute\'s poll runs from start, and focus polls only while the watch is on', async () => {
  const { watch, github, timers } = setup();
  github.prs.set(7, status('aaa', 'passing'));
  watch.focused();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(github.calls.length, 0);

  watch.start();
  await watch.poll();
  assert.equal(github.calls.length, 1);
  timers.tick();
  await watch.poll();
  assert.equal(github.calls.length, 2);
  watch.stop();
  assert.equal(timers.pending, 0);
});

test('gh missing or signed out: nothing is asked, nothing is fixed', async () => {
  const { watch, github, prompter } = setup();
  github.availability = 'unauthenticated';
  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  assert.deepEqual(github.calls, []);
  assert.equal(prompter.sent.length, 0);
});

/** Let every promise that can settle now, settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an action finishing polls its PR\'s repository at once, and keeps the dot amber until gh answers', async () => {
  const github = new FakeGitHub();
  const prompter = new FakePrompter();
  const session: WatchedSession = {
    ...SESSION,
    pullRequests: [...SESSION.pullRequests, { number: 3, url: 'https://github.com/o/lib/pull/3', repository: 'o/lib' }],
  };
  const { watch, dots, finishTurn } = setup({ github, prompter, sessions: [session] });
  github.prs.set(7, status('aaa', 'failing'));
  github.prs.set(3, status('lib', 'passing', { number: 3, url: 'https://github.com/o/lib/pull/3', repository: 'o/lib' }));
  watch.start();
  await watch.poll();
  assert.equal(prompter.sent.length, 1, 'attempt 1 is with Claude');
  assert.deepEqual(dots().at(-1)?.prs, [{ number: 7, dot: 'amber' }, { number: 3, dot: 'green' }]);
  const asked = github.calls.length;

  // Claude pushed and finished; GitHub is slow to answer.
  github.prs.set(7, status('bbb', 'pending'));
  let release!: () => void;
  github.gate = new Promise((resolve) => { release = resolve; });
  finishTurn();
  await settle();
  assert.deepEqual(github.calls.slice(asked), [[REPO, [7]]], 'only the PR\'s repository, without waiting for the minute');
  assert.ok(dots().every((pushed) => pushed.prs.every((pr) => pr.dot !== 'red')), 'never red in between');
  assert.deepEqual(dots().at(-1)?.prs, [{ number: 7, dot: 'amber' }, { number: 3, dot: 'green' }]);

  github.prs.set(7, status('bbb', 'passing'));
  github.gate = null;
  release();
  await watch.poll();
  assert.deepEqual(dots().at(-1)?.prs[0], { number: 7, dot: 'green' });
});

test('an answer asked for before the action finished does not end the amber', async () => {
  const github = new FakeGitHub();
  const { watch, dots, finishTurn } = setup({ github });
  github.prs.set(7, status('aaa', 'failing'));
  watch.start();
  await watch.poll();

  // The minute's poll is on its way when Claude finishes without fixing it.
  let release!: () => void;
  github.gate = new Promise((resolve) => { release = resolve; });
  const minute = watch.poll();
  await settle();
  finishTurn();
  github.gate = null;
  release();
  await minute;
  assert.equal(dots().at(-1)?.prs[0].dot, 'amber', 'that answer left before Claude finished');

  // The poll the finish asked for runs after it, and hands over attempt 2.
  await settle();
  await watch.poll();
  assert.ok(github.calls.length >= 3);
  assert.equal(dots().at(-1)?.prs[0].dot, 'amber', 'attempt 2 is with Claude');
});

test('without the watch on (the e2e suite), a finished action asks gh nothing', async () => {
  const { watch, github, finishTurn } = setup();
  github.prs.set(7, status('aaa', 'failing'));
  await watch.poll();
  finishTurn();
  await settle();
  assert.equal(github.calls.length, 1);
});
