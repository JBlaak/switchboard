import { test } from 'node:test';
import assert from 'node:assert/strict';

import { availableActions, currentActivity, NOT_RUNNING_REASON } from '../src/domain/session-work/actions';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { activityCard, itemButtons, queueLabel, type ActionState } from '../src/renderer/ui/session-work/describe';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { Activity, PullRequestStatus, SessionWorkItem, SessionWorkSnapshot } from '../src/domain/session-work/model';

const URL = 'https://github.com/acme/api/pull/52';
const NOW = Date.parse('2026-06-10T14:00:00.000Z');

function pr(extra: Partial<PullRequestStatus> = {}, activity: Activity | null = null): SessionWorkItem {
  return {
    id: 'pr:' + URL,
    kind: 'pr',
    pr: {
      number: 52, url: URL, repository: 'acme/api', state: 'open', baseRef: 'main', headRef: 'fix/login',
      checks: [{ name: 'test', state: 'passing' }], behindBy: 0, mergeable: 'mergeable', closes: [], ...extra,
    },
    location: { worktree: '/w/api', branch: 'fix/login', fromSubagent: false },
    diff: { kind: 'local', worktree: '/w/api', base: 'origin/main', head: 'fix/login' },
    activity,
  };
}

const branch: SessionWorkItem = {
  id: 'branch:/w/api-2\0spike',
  kind: 'branch',
  location: { worktree: '/w/api-2', branch: 'spike', fromSubagent: true },
  ahead: 2,
  diff: { kind: 'local', worktree: '/w/api-2', base: 'origin/main', head: 'spike' },
  activity: null,
  additions: 4,
  deletions: 0,
  pushed: false,
};

const dirty: SessionWorkItem = {
  id: 'dirty:/w/api\0fix/login',
  kind: 'dirty',
  location: { worktree: '/w/api', branch: 'fix/login', fromSubagent: false },
  files: [{ path: 'a.ts', status: 'modified' }],
  activity: null,
  additions: 1,
  deletions: 1,
};

const thread = (id: string, resolved: boolean) => ({
  id, path: 'a.ts', line: 1, side: 'RIGHT' as const, resolved, comments: [],
});

function activity(action: Activity['action'], phase: Activity['phase'], extra: Partial<Activity> = {}): Activity {
  return { id: 'a1', action, phase, origin: 'manual', queuedAt: '2026-06-10T13:50:00.000Z', ...extra };
}

const RUNNING: ActionState = { gh: 'ok', running: true, pending: null };

const labels = (item: SessionWorkItem, state = RUNNING) => itemButtons(item, state).map((b) => b.label);

// ── What an item offers (A3, A5) ──

test('a PR offers Ship it, then Open on GitHub', () => {
  /* When */
  const offered = labels(pr());

  /* Then */
  assert.deepEqual(offered, ['Ship it', 'Open on GitHub']);
});

test('a PR offers what it needs between Ship it and Open on GitHub', () => {
  /* Given */
  const needy = pr({
    behindBy: 3,
    checks: [{ name: 'test', state: 'failing' }],
    threads: [thread('T1', false), thread('T2', false), thread('T3', true)],
  });

  /* When */
  const offered = labels(needy);

  /* Then */
  assert.deepEqual(offered, ['Ship it', 'Rebase on origin/main', 'Fix CI', 'Fix comments (2)', 'Open on GitHub']);
});

test('a PR offers a rebase on its own base branch', () => {
  /* When */
  const offered = labels(pr({ behindBy: 1, baseRef: 'develop' }));

  /* Then */
  assert.deepEqual(offered, ['Ship it', 'Rebase on origin/develop', 'Open on GitHub']);
});

test('a PR in another repository only links out: the session has no checkout of it', () => {
  /* Given */
  const elsewhere = { ...pr({ behindBy: 1, checks: [{ name: 'test', state: 'failing' }] }), otherRepository: true } as SessionWorkItem;

  /* When */
  const offered = labels(elsewhere);

  /* Then */
  assert.deepEqual(availableActions(elsewhere, 'ok'), []);
  assert.deepEqual(offered, ['Open on GitHub']);
});

test('a merged PR only links out', () => {
  /* When */
  const offered = labels(pr({ state: 'merged' }));

  /* Then */
  assert.deepEqual(offered, ['Open on GitHub']);
});

test('a branch offers Open PR', () => {
  /* When */
  const offered = labels(branch);

  /* Then */
  assert.deepEqual(offered, ['Open a new PR']);
});

test('uncommitted changes offer Create a pull request', () => {
  /* When */
  const offered = labels(dirty);
  const actions = availableActions(dirty, 'ok');

  /* Then */
  assert.deepEqual(offered, ['Create a pull request']);
  assert.deepEqual(actions, ['create-pr']);
});

test('uncommitted changes offer nothing without gh', () => {
  /* When */
  const actions = availableActions(dirty, 'missing');

  /* Then */
  assert.deepEqual(actions, []);
});

test('Create a pull request says so while Claude is on it', () => {
  /* Given */
  const creating: SessionWorkItem = {
    ...dirty, activity: { id: 'a1', action: 'create-pr', phase: 'sent', origin: 'manual', queuedAt: '2026-01-01T00:00:00Z' },
  };

  /* When */
  const buttons = itemButtons(creating, RUNNING);

  /* Then */
  assert.deepEqual(buttons.map((b) => [b.label, b.tone, b.disabled]),
    [['Creating PR…', 'primary', 'Claude is on it']]);
});

test('without gh no action is offered (D9)', () => {
  /* When */
  const missing = availableActions(pr({ behindBy: 2 }), 'missing');
  const unauthenticated = availableActions(branch, 'unauthenticated');

  /* Then */
  assert.deepEqual(missing, []);
  assert.deepEqual(unauthenticated, []);
});

test('without gh a PR still links out', () => {
  /* When */
  const offered = labels(pr(), { ...RUNNING, gh: 'missing' });

  /* Then */
  assert.deepEqual(offered, ['Open on GitHub']);
});

test('Ship it is primary and Fix CI a warning; Open on GitHub always works', () => {
  /* Given */
  const failing = pr({ checks: [{ name: 'test', state: 'failing' }] });

  /* When */
  const buttons = itemButtons(failing, RUNNING);

  /* Then */
  assert.deepEqual(buttons.map((b) => [b.id, b.tone, b.disabled]), [
    ['ship', 'primary', null],
    ['fix-ci', 'warn', null],
    ['github', 'plain', null],
  ]);
  assert.equal(buttons[2].hint, URL);
});

test('a session that is not running disables every action and says why', () => {
  /* When */
  const buttons = itemButtons(pr({ behindBy: 1 }), { ...RUNNING, running: false });

  /* Then */
  assert.deepEqual(buttons.map((b) => b.disabled), [NOT_RUNNING_REASON, NOT_RUNNING_REASON, null]);
});

test('a session that is not running disables a branch\'s Open PR', () => {
  /* When */
  const [openPr] = itemButtons(branch, { ...RUNNING, running: false });

  /* Then */
  assert.equal(openPr.disabled, 'Start the session to hand this to Claude');
});

test('a queued Ship it reads "Shipping…" and cannot be pressed again', () => {
  /* When */
  const [queued] = itemButtons(pr({}, activity('ship', 'queued')), RUNNING);

  /* Then */
  assert.equal(queued.label, 'Shipping…');
  assert.match(queued.disabled!, /^Queued/);
});

test('a Ship it with Claude reads "Shipping…" and cannot be pressed again', () => {
  /* When */
  const [sent] = itemButtons(pr({}, activity('ship', 'sent')), RUNNING);

  /* Then */
  assert.equal(sent.label, 'Shipping…');
  assert.equal(sent.disabled, 'Claude is on it');
});

test('a Ship it that is done can be pressed again', () => {
  /* When */
  const [done] = itemButtons(pr({}, activity('ship', 'done')), RUNNING);

  /* Then */
  assert.equal(done.label, 'Ship it');
  assert.equal(done.disabled, null);
});

test('while main is asked, that item\'s buttons wait for the answer', () => {
  /* When */
  const buttons = itemButtons(pr(), { ...RUNNING, pending: { itemId: 'pr:' + URL, action: 'ship' } });

  /* Then */
  assert.ok(buttons[0].disabled);
  assert.equal(buttons[1].disabled, null, 'Open on GitHub still works');
});

// ── The card ──

test('the card shows the action with Claude, else the next one waiting, else the one given up on', () => {
  /* Given */
  const queued = activity('rebase', 'queued', { id: 'q' });
  const sent = activity('ship', 'sent', { id: 's' });
  const gaveUp = activity('fix-ci', 'gave-up', { id: 'g' });
  const cases: Array<[Activity[], string | undefined]> = [
    [[], undefined],
    [[queued, sent], 's'],
    [[gaveUp, queued], 'q'],
    [[gaveUp, activity('ship', 'done')], 'g'],
    [[activity('ship', 'done')], undefined],
  ];

  for (const [activities, expected] of cases) {
    /* When */
    const current = currentActivity(activities);

    /* Then */
    if (expected === undefined) assert.equal(current, null);
    else assert.equal(current?.id, expected);
  }
});

test('queued: a grey card with Cancel', () => {
  /* Given */
  const item = pr({ threads: [thread('T1', false), thread('T2', false)] }, activity('fix-comments', 'queued', { id: 'q1' }));

  /* When */
  const card = activityCard(item, NOW);

  /* Then */
  assert.deepEqual(card, {
    tone: 'grey',
    title: 'Queued: fix 2 review comments',
    detail: 'Sends when the session finishes its current turn',
    cancelId: 'q1',
    viewInTerminal: false,
    steps: [],
  });
});

test('sent: an amber card with View in terminal and no Cancel', () => {
  /* Given */
  const item = pr({}, activity('rebase', 'sent', { sentAt: new Date(NOW - 120_000).toISOString() }));

  /* When */
  const card = activityCard(item, NOW)!;

  /* Then */
  assert.equal(card.tone, 'amber');
  assert.equal(card.title, 'Claude is on it: rebase #52');
  assert.equal(card.detail, 'Sent to the session · started 2m ago');
  assert.equal(card.cancelId, null);
  assert.equal(card.viewInTerminal, true);
});

const shipping = activity('ship', 'sent', { sentAt: new Date(NOW - 5_000).toISOString() });

test('Ship it: a blue card with the four steps, from what GitHub says', () => {
  /* Given */
  const item = pr({ checks: [{ name: 'test', state: 'pending' }] }, shipping);

  /* When */
  const card = activityCard(item, NOW)!;

  /* Then */
  assert.equal(card.tone, 'blue');
  assert.equal(card.title, 'Shipping #52');
  assert.equal(card.detail, 'Claude is working through it in the session · started just now');
  assert.deepEqual(card.steps, [
    { label: 'Rebased', state: 'done' },
    { label: 'Waiting for CI', state: 'running' },
    { label: 'Merge', state: 'todo' },
    { label: 'Clean up', state: 'todo' },
  ]);
});

test('Ship it: once merged, only the clean-up is left', () => {
  /* Given */
  const item = pr({ state: 'merged', checks: [{ name: 'test', state: 'passing' }] }, shipping);

  /* When */
  const merged = activityCard(item, NOW)!;

  /* Then */
  assert.deepEqual(merged.steps.map((s) => s.state), ['done', 'done', 'done', 'running']);
});

test('gave up: a red card', () => {
  /* When */
  const card = activityCard(pr({}, activity('fix-ci', 'gave-up')), NOW);

  /* Then */
  assert.equal(card?.tone, 'red');
});

test('done, or no activity at all: no card', () => {
  /* Given */
  const items = [pr({}, activity('ship', 'done')), pr(), dirty];

  for (const item of items) {
    /* When */
    const card = activityCard(item, NOW);

    /* Then */
    assert.equal(card, null);
  }
});

test('the header says the session is busy while anything is queued', () => {
  /* Given */
  const snapshot = (queued: number): SessionWorkSnapshot =>
    ({ sessionId: 's1', repository: 'acme/api', items: [], footprint: { worktrees: 0, branches: 0 }, queued, gh: 'ok', updatedAt: '' });

  /* When */
  const idle = queueLabel(snapshot(0));
  const busy = queueLabel(snapshot(2));

  /* Then */
  assert.equal(idle, null);
  assert.equal(busy, 'Session busy · 2 queued');
});

// ── The slice ──

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const item = pr();
const opened = (): RendererState => run(initialRendererState('s1'),
  { type: 'sessionWorkOpened', sessionId: 's1', name: 'Fix login', at: NOW },
  { type: 'sessionWorkSnapshot', snapshot: {
    sessionId: 's1', repository: 'acme/api', items: [item, branch], footprint: { worktrees: 2, branches: 2 },
    queued: 0, gh: 'ok', updatedAt: '',
  } });
const ask: RendererEvent = { type: 'sessionWorkActionRequested', sessionId: 's1', itemId: item.id, action: 'ship' };
const refuse: RendererEvent = { type: 'sessionWorkActionAnswered', sessionId: 's1', itemId: item.id, error: 'Start the session' };

test('an action asked for waits for main', () => {
  /* Given */
  const state = opened();

  /* When */
  const asked = run(state, ask);

  /* Then */
  assert.deepEqual(asked.sessionWork.page?.pendingAction, { itemId: item.id, action: 'ship' });
});

test('a second press while the first is asked does nothing', () => {
  /* Given */
  const asked = run(opened(), ask);

  /* When */
  const again = run(asked, ask);

  /* Then */
  assert.strictEqual(again, asked, 'a second press while the first is asked does nothing');
});

test('a refusal shows on its item', () => {
  /* Given */
  const asked = run(opened(), ask);

  /* When */
  const refused = run(asked, refuse);

  /* Then */
  assert.equal(refused.sessionWork.page?.pendingAction, null);
  assert.deepEqual(refused.sessionWork.page?.actionError, { itemId: item.id, message: 'Start the session' });
});

test('a refusal clears when another item is selected', () => {
  /* Given */
  const refused = run(opened(), ask, refuse);

  /* When */
  const elsewhere = run(refused, { type: 'sessionWorkItemSelected', itemId: branch.id });

  /* Then */
  assert.equal(elsewhere.sessionWork.page?.actionError, null);
});

test('an action main queued leaves nothing pending and no error', () => {
  /* Given */
  const asked = run(opened(), ask);

  /* When */
  const queued = run(asked, { type: 'sessionWorkActionAnswered', sessionId: 's1', itemId: item.id, error: null });

  /* Then */
  assert.equal(queued.sessionWork.page?.actionError, null);
  assert.equal(queued.sessionWork.page?.pendingAction, null);
});

test('an answer for another session\'s page is dropped', () => {
  /* Given */
  const state = opened();

  /* When */
  const next = run(state, { type: 'sessionWorkActionAnswered', sessionId: 'other', itemId: item.id, error: 'x' });

  /* Then */
  assert.strictEqual(next, state, 'an answer for another session\'s page is dropped');
});
