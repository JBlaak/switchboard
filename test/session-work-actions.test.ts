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

test('a PR offers Ship it, then only what it needs, then Open on GitHub', () => {
  assert.deepEqual(labels(pr()), ['Ship it', 'Open on GitHub']);
  assert.deepEqual(labels(pr({
    behindBy: 3,
    checks: [{ name: 'test', state: 'failing' }],
    threads: [thread('T1', false), thread('T2', false), thread('T3', true)],
  })), ['Ship it', 'Rebase on origin/main', 'Fix CI', 'Fix comments (2)', 'Open on GitHub']);
  assert.deepEqual(labels(pr({ behindBy: 1, baseRef: 'develop' })), ['Ship it', 'Rebase on origin/develop', 'Open on GitHub']);
});

test('a merged PR only links out; a branch offers Open PR; uncommitted changes offer Create a pull request', () => {
  assert.deepEqual(labels(pr({ state: 'merged' })), ['Open on GitHub']);
  assert.deepEqual(labels(branch), ['Open PR']);
  assert.deepEqual(labels(dirty), ['Create a pull request']);
  assert.deepEqual(availableActions(dirty, 'ok'), ['create-pr']);
  assert.deepEqual(availableActions(dirty, 'missing'), []);
});

test('Create a pull request says so while Claude is on it', () => {
  const creating: SessionWorkItem = {
    ...dirty, activity: { id: 'a1', action: 'create-pr', phase: 'sent', origin: 'manual', queuedAt: '2026-01-01T00:00:00Z' },
  };
  assert.deepEqual(itemButtons(creating, RUNNING).map((b) => [b.label, b.tone, b.disabled]),
    [['Creating PR…', 'primary', 'Claude is on it']]);
});

test('without gh no action is offered (D9)', () => {
  assert.deepEqual(availableActions(pr({ behindBy: 2 }), 'missing'), []);
  assert.deepEqual(availableActions(branch, 'unauthenticated'), []);
  assert.deepEqual(labels(pr(), { ...RUNNING, gh: 'missing' }), ['Open on GitHub']);
});

test('Ship it is primary and Fix CI a warning; Open on GitHub always works', () => {
  const buttons = itemButtons(pr({ checks: [{ name: 'test', state: 'failing' }] }), RUNNING);
  assert.deepEqual(buttons.map((b) => [b.id, b.tone, b.disabled]), [
    ['ship', 'primary', null],
    ['fix-ci', 'warn', null],
    ['github', 'plain', null],
  ]);
  assert.equal(buttons[2].hint, URL);
});

test('a session that is not running disables every action and says why', () => {
  const buttons = itemButtons(pr({ behindBy: 1 }), { ...RUNNING, running: false });
  assert.deepEqual(buttons.map((b) => b.disabled), [NOT_RUNNING_REASON, NOT_RUNNING_REASON, null]);
  assert.equal(itemButtons(branch, { ...RUNNING, running: false })[0].disabled, 'Start the session to hand this to Claude');
});

test('a Ship it waiting or with Claude reads "Shipping…" and cannot be pressed again', () => {
  const [queued] = itemButtons(pr({}, activity('ship', 'queued')), RUNNING);
  assert.equal(queued.label, 'Shipping…');
  assert.match(queued.disabled!, /^Queued/);
  const [sent] = itemButtons(pr({}, activity('ship', 'sent')), RUNNING);
  assert.equal(sent.label, 'Shipping…');
  assert.equal(sent.disabled, 'Claude is on it');
  const [done] = itemButtons(pr({}, activity('ship', 'done')), RUNNING);
  assert.equal(done.label, 'Ship it');
  assert.equal(done.disabled, null);
});

test('while main is asked, that item\'s buttons wait for the answer', () => {
  const buttons = itemButtons(pr(), { ...RUNNING, pending: { itemId: 'pr:' + URL, action: 'ship' } });
  assert.ok(buttons[0].disabled);
  assert.equal(buttons[1].disabled, null, 'Open on GitHub still works');
});

// ── The card ──

test('the card shows the action with Claude, else the next one waiting, else the one given up on', () => {
  assert.equal(currentActivity([]), null);
  const queued = activity('rebase', 'queued', { id: 'q' });
  const sent = activity('ship', 'sent', { id: 's' });
  const gaveUp = activity('fix-ci', 'gave-up', { id: 'g' });
  assert.equal(currentActivity([queued, sent])?.id, 's');
  assert.equal(currentActivity([gaveUp, queued])?.id, 'q');
  assert.equal(currentActivity([gaveUp, activity('ship', 'done')])?.id, 'g');
  assert.equal(currentActivity([activity('ship', 'done')]), null);
});

test('queued: a grey card with Cancel', () => {
  const card = activityCard(pr({ threads: [thread('T1', false), thread('T2', false)] }, activity('fix-comments', 'queued', { id: 'q1' })), NOW);
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
  const card = activityCard(pr({}, activity('rebase', 'sent', { sentAt: new Date(NOW - 120_000).toISOString() })), NOW)!;
  assert.equal(card.tone, 'amber');
  assert.equal(card.title, 'Claude is on it: rebase #52');
  assert.equal(card.detail, 'Sent to the session · started 2m ago');
  assert.equal(card.cancelId, null);
  assert.equal(card.viewInTerminal, true);
});

test('Ship it: a blue card with the four steps, from what GitHub says', () => {
  const shipping = activity('ship', 'sent', { sentAt: new Date(NOW - 5_000).toISOString() });
  const card = activityCard(pr({ checks: [{ name: 'test', state: 'pending' }] }, shipping), NOW)!;
  assert.equal(card.tone, 'blue');
  assert.equal(card.title, 'Shipping #52');
  assert.equal(card.detail, 'Claude is working through it in the session · started just now');
  assert.deepEqual(card.steps, [
    { label: 'Rebased', state: 'done' },
    { label: 'Waiting for CI', state: 'running' },
    { label: 'Merge', state: 'todo' },
    { label: 'Clean up', state: 'todo' },
  ]);

  const merged = activityCard(pr({ state: 'merged', checks: [{ name: 'test', state: 'passing' }] }, shipping), NOW)!;
  assert.deepEqual(merged.steps.map((s) => s.state), ['done', 'done', 'done', 'running']);
});

test('gave up: a red card; done: no card', () => {
  assert.equal(activityCard(pr({}, activity('fix-ci', 'gave-up')), NOW)?.tone, 'red');
  assert.equal(activityCard(pr({}, activity('ship', 'done')), NOW), null);
  assert.equal(activityCard(pr(), NOW), null);
  assert.equal(activityCard(dirty, NOW), null);
});

test('the header says the session is busy while anything is queued', () => {
  const snapshot = (queued: number): SessionWorkSnapshot =>
    ({ sessionId: 's1', repository: 'acme/api', items: [], footprint: { worktrees: 0, branches: 0 }, queued, gh: 'ok', updatedAt: '' });
  assert.equal(queueLabel(snapshot(0)), null);
  assert.equal(queueLabel(snapshot(2)), 'Session busy · 2 queued');
});

// ── The slice ──

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

test('an action asked for waits for main; a refusal shows on its item until the next action or selection', () => {
  const item = pr();
  const opened = run(initialRendererState('s1'),
    { type: 'sessionWorkOpened', sessionId: 's1', name: 'Fix login', at: NOW },
    { type: 'sessionWorkSnapshot', snapshot: {
      sessionId: 's1', repository: 'acme/api', items: [item, branch], footprint: { worktrees: 2, branches: 2 },
      queued: 0, gh: 'ok', updatedAt: '',
    } });

  const asked = run(opened, { type: 'sessionWorkActionRequested', sessionId: 's1', itemId: item.id, action: 'ship' });
  assert.deepEqual(asked.sessionWork.page?.pendingAction, { itemId: item.id, action: 'ship' });
  assert.strictEqual(
    run(asked, { type: 'sessionWorkActionRequested', sessionId: 's1', itemId: item.id, action: 'ship' }), asked,
    'a second press while the first is asked does nothing');

  const refused = run(asked, { type: 'sessionWorkActionAnswered', sessionId: 's1', itemId: item.id, error: 'Start the session' });
  assert.equal(refused.sessionWork.page?.pendingAction, null);
  assert.deepEqual(refused.sessionWork.page?.actionError, { itemId: item.id, message: 'Start the session' });

  const elsewhere = run(refused, { type: 'sessionWorkItemSelected', itemId: branch.id });
  assert.equal(elsewhere.sessionWork.page?.actionError, null);

  const queued = run(asked, { type: 'sessionWorkActionAnswered', sessionId: 's1', itemId: item.id, error: null });
  assert.equal(queued.sessionWork.page?.actionError, null);
  assert.equal(queued.sessionWork.page?.pendingAction, null);

  assert.strictEqual(
    run(opened, { type: 'sessionWorkActionAnswered', sessionId: 'other', itemId: item.id, error: 'x' }), opened,
    'an answer for another session\'s page is dropped');
});
