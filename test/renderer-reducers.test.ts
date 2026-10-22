import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { busyChanged } from '../src/renderer/state/activity-slice';
import { sessionsInFlightIn } from '../src/renderer/state/remote-slice';
import { tightestIn } from '../src/renderer/state/usage-slice';
import { sessionKeyIn } from '../src/renderer/state/keys-slice';
import { rowActivity } from '../src/renderer/state/row-activity';
import type { PushEvent, RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { PendingQuestions } from '../src/domain/questions/question';

/** Freeze a state all the way down, so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(deepFreeze(s), e), state);
}

const initial = (active: string | null = null) => initialRendererState(active);
/** `id` active and its terminal on screen, as `showSession` leaves it: the main area's route is what "on screen" means. */
const shownOnScreen = (id: string) => run(initial(id), { type: 'sessionShown', sessionId: id, name: id });

function asked(sessionId: string, toolUseId: string, count = 1): PendingQuestions {
  return {
    sessionId,
    toolUseId,
    questions: Array.from({ length: count }, (_, i) => ({
      question: `q${i}`, header: 'h', multiSelect: false, options: [{ label: 'a', description: '' }],
    })) as unknown as PendingQuestions['questions'],
    askedAt: 0,
    deadline: 600_000,
  };
}

// ── Every push event ──

/** One of each; typed so a push channel without a sample fails to compile. */
const SAMPLES: { [K in PushEvent['type']]: Extract<PushEvent, { type: K }> } = {
  processExited: { type: 'processExited', sessionId: 's1', exitCode: 0 },
  sessionForked: { type: 'sessionForked', oldId: 's1', newId: 's2' },
  cliBusyState: { type: 'cliBusyState', sessionId: 's1', busy: true },
  terminalNotification: { type: 'terminalNotification', sessionId: 's1', message: 'Claude needs your permission' },
  sessionNeedsAttention: { type: 'sessionNeedsAttention', sessionId: 's1' },
  sessionAgents: { type: 'sessionAgents', sessionId: 's1', agents: [{ id: 'a', title: 'x' } as never] },
  remoteStatus: { type: 'remoteStatus', sessionId: 's1', status: { phase: 'connecting' }, receivedAt: 5 },
  questionsAsked: { type: 'questionsAsked', pending: asked('s1', 't1') },
  questionsSettled: { type: 'questionsSettled', settled: { sessionId: 's1', toolUseId: 't1', outcome: 'answered' } },
  projectsChanged: { type: 'projectsChanged' },
  statusUpdate: { type: 'statusUpdate', text: 'Scanning…', kind: 'active' },
  fullscreenChanged: { type: 'fullscreenChanged', isFullscreen: true },
  updateAvailable: { type: 'updateAvailable', update: { version: '9.9.9', pageUrl: 'u', installable: true } },
  sessionWorkSnapshot: { type: 'sessionWorkSnapshot', snapshot: { sessionId: 's1', repository: '', items: [], footprint: { worktrees: 0, branches: 0 }, queued: 0, gh: 'ok', updatedAt: 'now' } },
  prStatusChanged: { type: 'prStatusChanged', change: { sessionId: 's1', prs: [{ number: 7, dot: 'red' }], needsYou: true } },
  launchRequested: { type: 'launchRequested', projectPath: '/code/app', initialPrompt: 'Fix it.' },
  pickerRequested: { type: 'pickerRequested', initialPrompt: 'fix it', reason: 'No idea.' },
};

test('every push event reduces without mutating the state it was given', () => {
  /* Given */
  const events = Object.values(SAMPLES);

  for (const event of events) {
    /* When */
    const act = () => rootReducer(deepFreeze(initial()), event);

    /* Then */
    assert.doesNotThrow(act, event.type);
  }
});

test('pushes that are only prompts to act leave the state as it was', () => {
  // These have follow-ups (a banner, a re-fetch, a class on <html>) but
  // nothing for the store to record. The status line and the update notice
  // are in the store now; see footer-slices.test.ts.
  /* Given */
  const types = ['processExited', 'projectsChanged', 'fullscreenChanged', 'sessionWorkSnapshot', 'launchRequested', 'pickerRequested'] as const;

  for (const type of types) {
    const state = initial();

    /* When */
    const next = rootReducer(state, SAMPLES[type]);

    /* Then */
    assert.strictEqual(next, state, type);
  }
});

// ── cliBusyState ──

/** A turn that started and ended in s1, with `active` on screen. */
const turnEnded = (active: string | null = null) => run(initial(active),
  { type: 'cliBusyState', sessionId: 's1', busy: true },
  { type: 'cliBusyState', sessionId: 's1', busy: false });

test('a turn starting marks the session busy', () => {
  /* When */
  const state = run(initial(), { type: 'cliBusyState', sessionId: 's1', busy: true });

  /* Then */
  assert.strictEqual(state.activity.busy.s1, true);
  assert.ok(!state.activity.ready.s1);
});

test('a turn ending off screen leaves the answer unread', () => {
  /* Given */
  const busy = run(initial('other'), { type: 'cliBusyState', sessionId: 's1', busy: true });

  /* When */
  const state = run(busy, { type: 'cliBusyState', sessionId: 's1', busy: false });

  /* Then */
  assert.strictEqual(state.activity.busy.s1, false);
  assert.strictEqual(state.activity.ready.s1, true);
});

test('a turn ending on screen is read by definition', () => {
  /* Given */
  const busy = run(shownOnScreen('s1'), { type: 'cliBusyState', sessionId: 's1', busy: true });

  /* When */
  const state = run(busy, { type: 'cliBusyState', sessionId: 's1', busy: false });

  /* Then */
  assert.ok(!state.activity.ready.s1);
});

test('a late idle signal does not clear an unread answer', () => {
  /* Given */
  const ready = turnEnded();

  /* When */
  const state = run(ready, { type: 'cliBusyState', sessionId: 's1', busy: false });

  /* Then */
  assert.strictEqual(state, ready);
});

test('a new turn supersedes an unread answer', () => {
  /* Given */
  const ready = turnEnded();

  /* When */
  const state = run(ready, { type: 'cliBusyState', sessionId: 's1', busy: true });

  /* Then */
  assert.ok(!state.activity.ready.s1);
  assert.strictEqual(state.activity.busy.s1, true);
});

test('busyChanged reports an idle→busy flip', () => {
  /* Given */
  const idle = initial();
  const busy = run(idle, { type: 'cliBusyState', sessionId: 's1', busy: true });

  /* When */
  const changed = busyChanged(idle.activity, busy.activity, 's1');

  /* Then */
  assert.ok(changed);
});

test('busyChanged ignores busy reported again', () => {
  /* Given */
  const busy = run(initial(), { type: 'cliBusyState', sessionId: 's1', busy: true });
  const again = run(busy, SAMPLES.cliBusyState);

  /* When */
  const changed = busyChanged(busy.activity, again.activity, 's1');

  /* Then */
  assert.ok(!changed);
});

test('busyChanged ignores idle for a session never seen busy', () => {
  // Idle reported for a session never seen busy: false either way.
  /* Given */
  const idle = initial();
  const stillIdle = run(idle, { type: 'cliBusyState', sessionId: 's1', busy: false });

  /* When */
  const changed = busyChanged(idle.activity, stillIdle.activity, 's1');

  /* Then */
  assert.ok(!changed);
});

// ── Attention ──

test('a notification asking for a person marks the session as needing input', () => {
  /* Given */
  const messages = ['needs your attention', 'needs your approval for the plan',
    'needs your permission to use Bash', 'wants to enter plan mode'];

  for (const message of messages) {
    /* When */
    const state = run(initial(), { type: 'terminalNotification', sessionId: 's1', message });

    /* Then */
    assert.strictEqual(state.activity.attention.s1, true, message);
  }
});

test('"waiting for your input" settles the session instead', () => {
  /* Given */
  const busy = run(initial('other'), { type: 'cliBusyState', sessionId: 's1', busy: true });

  /* When */
  const state = run(busy,
    { type: 'terminalNotification', sessionId: 's1', message: 'Claude is waiting for your input' });

  /* Then */
  assert.strictEqual(state.activity.busy.s1, false);
  assert.strictEqual(state.activity.ready.s1, true);
  assert.ok(!state.activity.attention.s1);
});

test('any other notification changes nothing', () => {
  /* Given */
  const state = initial();

  /* When */
  const next = rootReducer(state, { type: 'terminalNotification', sessionId: 's1', message: 'Build done' });

  /* Then */
  assert.strictEqual(next, state);
});

test('sessionNeedsAttention marks the session', () => {
  /* When */
  const state = run(initial(), SAMPLES.sessionNeedsAttention);

  /* Then */
  assert.strictEqual(state.activity.attention.s1, true);
});

test('sessionNeedsAttention changes nothing for the session on screen', () => {
  /* Given */
  const onScreen = shownOnScreen('s1');

  /* When */
  const next = rootReducer(onScreen, SAMPLES.sessionNeedsAttention);

  /* Then */
  assert.strictEqual(next, onScreen);
});

test('viewing a session clears its unread and waiting marks, but not its busy state', () => {
  /* Given */
  const marked = run(turnEnded('other'), { type: 'sessionNeedsAttention', sessionId: 's1' });

  /* When */
  const state = run(marked, { type: 'sessionViewed', sessionId: 's1' });

  /* Then */
  assert.ok(!state.activity.ready.s1);
  assert.ok(!state.activity.attention.s1);
  assert.strictEqual(state.activity.busy.s1, false);
});

// ── Agents ──

test('sessionAgents records the working agents', () => {
  /* When */
  const withAgents = run(initial(), SAMPLES.sessionAgents);

  /* Then */
  assert.strictEqual(withAgents.activity.agents.s1, SAMPLES.sessionAgents.agents);
});

test('sessionAgents with an empty list forgets them', () => {
  /* Given */
  const withAgents = run(initial(), SAMPLES.sessionAgents);

  /* When */
  const cleared = run(withAgents, { type: 'sessionAgents', sessionId: 's1', agents: [] });

  /* Then */
  assert.ok(!('s1' in cleared.activity.agents));
});

/** s1 busy, waiting and with agents, then all of it cleared. */
const activityClearedState = () => run(initial(),
  { type: 'cliBusyState', sessionId: 's1', busy: true },
  { type: 'sessionNeedsAttention', sessionId: 's1' },
  SAMPLES.sessionAgents,
  { type: 'activityCleared', sessionId: 's1' });

test('activityCleared drops everything, the agents included', () => {
  /* Given */
  const marked = run(initial(),
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'sessionNeedsAttention', sessionId: 's1' },
    SAMPLES.sessionAgents);

  /* When */
  const state = run(marked, { type: 'activityCleared', sessionId: 's1' });

  /* Then */
  assert.deepStrictEqual(state.activity, { attention: {}, ready: {}, busy: {}, agents: {} });
});

test('activityCleared again is a no-op', () => {
  // Clearing again is a no-op, so the per-row poll sweep costs nothing.
  /* Given */
  const state = activityClearedState();

  /* When */
  const next = rootReducer(state, { type: 'activityCleared', sessionId: 's1' });

  /* Then */
  assert.strictEqual(next, state);
});

// ── Remote status ──

test('remoteStatus records when a connect started from when it arrived', () => {
  /* When */
  const connecting = run(initial(), SAMPLES.remoteStatus);

  /* Then */
  assert.strictEqual(connecting.remote.statuses.s1.startedAt, 5);
});

test('remoteStatus resolves a retry delay against when it arrived', () => {
  /* Given */
  const connecting = run(initial(), SAMPLES.remoteStatus);

  /* When */
  const retrying = run(connecting, {
    type: 'remoteStatus', sessionId: 's1', status: { phase: 'retrying', delayMs: 2000 }, receivedAt: 100,
  });

  /* Then */
  assert.strictEqual(retrying.remote.statuses.s1.retryAt, 2100);
  assert.deepStrictEqual(sessionsInFlightIn(retrying.remote), ['s1']);
});

test('a disconnect forgets the status', () => {
  /* Given */
  const connecting = run(initial(), SAMPLES.remoteStatus);

  /* When */
  const gone = run(connecting, {
    type: 'remoteStatus', sessionId: 's1', status: { phase: 'disconnected' }, receivedAt: 6,
  });

  /* Then */
  assert.deepStrictEqual(gone.remote.statuses, {});
});

test('the terminal going forgets the status', () => {
  /* Given */
  const connecting = run(initial(), SAMPLES.remoteStatus);

  /* When */
  const gone = run(connecting, { type: 'remoteStatusForgotten', sessionId: 's1' });

  /* Then */
  assert.deepStrictEqual(gone.remote.statuses, {});
});

test('a connected session is no longer in flight', () => {
  /* Given */
  const connecting = run(initial(), SAMPLES.remoteStatus);

  /* When */
  const state = run(connecting, {
    type: 'remoteStatus', sessionId: 's1', status: { phase: 'connected' }, receivedAt: 6,
  });

  /* Then */
  assert.deepStrictEqual(sessionsInFlightIn(state.remote), []);
});

test('remoteTick moves the shared clock', () => {
  /* When */
  const state = run(initial(), { type: 'remoteTick', at: 42 });

  /* Then */
  assert.strictEqual(state.remote.tickAt, 42);
});

// ── Questions ──

test('questionsAsked records the set', () => {
  /* When */
  const state = run(initial(), SAMPLES.questionsAsked);

  /* Then */
  assert.strictEqual(state.questions.bySession.s1.toolUseId, 't1');
});

test('questionsAsked with the same set again is ignored', () => {
  /* Given */
  const state = run(initial(), SAMPLES.questionsAsked);

  /* When */
  const next = rootReducer(state, SAMPLES.questionsAsked);

  /* Then */
  assert.strictEqual(next, state);
});

test('questionsAsked with a different set replaces it', () => {
  /* Given */
  const state = run(initial(), SAMPLES.questionsAsked);

  /* When */
  const next = run(state, { type: 'questionsAsked', pending: asked('s1', 't2') });

  /* Then */
  assert.strictEqual(next.questions.bySession.s1.toolUseId, 't2');
});

test('questionsSettled removes the set, found by tool-use id', () => {
  /* Given */
  const asking = run(initial(), SAMPLES.questionsAsked);

  /* When */
  const state = run(asking, {
    type: 'questionsSettled', settled: { sessionId: 'stale-id', toolUseId: 't1', outcome: 'withdrawn' },
  });

  /* Then */
  assert.deepStrictEqual(state.questions.bySession, {});
});

test('a set settled before the bootstrap fetch returned it stays settled', () => {
  /* Given */
  const settled = run(initial(), SAMPLES.questionsSettled);

  /* When */
  const state = run(settled, SAMPLES.questionsAsked);

  /* Then */
  assert.deepStrictEqual(state.questions.bySession, {});
});

test('sessionForked moves a set to the new id', () => {
  /* Given */
  const asking = run(initial(), SAMPLES.questionsAsked);

  /* When */
  const state = run(asking, SAMPLES.sessionForked);

  /* Then */
  assert.ok(!state.questions.bySession.s1);
  assert.strictEqual(state.questions.bySession.s2.sessionId, 's2');
});

test('sessionForked keeps a set main already asked under the new id', () => {
  /* Given */
  const asking = run(initial(), SAMPLES.questionsAsked,
    { type: 'questionsAsked', pending: asked('s2', 't9') });

  /* When */
  const state = run(asking, SAMPLES.sessionForked);

  /* Then */
  assert.strictEqual(state.questions.bySession.s2.toolUseId, 't9');
});

// ── Re-keying ──

/** Every session id any slice holds, as a key or as a value that names one. */
function idsHeldIn(state: RendererState): Set<string> {
  const ids = new Set<string>();
  const { view, activity, questions, remote, keys } = state;
  if (view.activeSessionId) ids.add(view.activeSessionId);
  for (const id of view.activePtyIds) ids.add(id);
  for (const id of view.searchMatchIds ?? []) ids.add(id);
  for (const record of [activity.attention, activity.ready, activity.busy, activity.agents,
    questions.bySession, remote.statuses, keys.byId]) {
    for (const id of Object.keys(record)) ids.add(id);
  }
  for (const pending of Object.values(questions.bySession)) ids.add(pending.sessionId);
  return ids;
}

/** s1 on screen, running, matched, busy, waiting, with agents, asking, connecting and keyed. */
function everythingAbout(sessionId: string): RendererState {
  return run(initial(),
    { type: 'sessionsSeen', sessionIds: ['other', sessionId] },
    { type: 'viewPatched', patch: { activePtyIds: new Set([sessionId]), searchMatchIds: new Set([sessionId]) } },
    { type: 'cliBusyState', sessionId, busy: true },
    { type: 'sessionNeedsAttention', sessionId },
    { type: 'sessionAgents', sessionId, agents: [{ id: 'a', title: 'x' } as never] },
    { type: 'questionsAsked', pending: asked(sessionId, 't1') },
    { type: 'remoteStatus', sessionId, status: { phase: 'connecting' }, receivedAt: 5 },
    { type: 'activeSessionChanged', sessionId },
  );
}

test('after a re-key no slice holds the old id', () => {
  /* Given */
  const before = everythingAbout('s1');

  /* When */
  const state = run(before, SAMPLES.sessionForked);

  /* Then */
  assert.ok(!idsHeldIn(state).has('s1'), [...idsHeldIn(state)].join(','));
});

test('a re-key carries everything over to the new id', () => {
  /* Given */
  const before = everythingAbout('s1');

  /* When */
  const state = run(before, SAMPLES.sessionForked);

  /* Then */
  assert.strictEqual(state.view.activeSessionId, 's2');
  assert.deepStrictEqual([...state.view.activePtyIds], ['s2']);
  assert.deepStrictEqual([...state.view.searchMatchIds!], ['s2']);
  assert.strictEqual(state.activity.busy.s2, true);
  assert.strictEqual(state.activity.agents.s2, before.activity.agents.s1);
  assert.strictEqual(state.questions.bySession.s2.toolUseId, 't1');
  assert.strictEqual(state.questions.bySession.s2.sessionId, 's2');
  assert.strictEqual(state.remote.statuses.s2, before.remote.statuses.s1);
  assert.strictEqual(state.keys.byId.s2, before.keys.byId.s1);
});

test('a re-key carries the waiting and unread marks of a session off screen', () => {
  /* Given */
  const marked = run(turnEnded('elsewhere'), { type: 'sessionNeedsAttention', sessionId: 's1' });

  /* When */
  const state = run(marked, SAMPLES.sessionForked);

  /* Then */
  assert.strictEqual(state.activity.ready.s2, true);
  assert.strictEqual(state.activity.attention.s2, true);
  assert.ok(!idsHeldIn(state).has('s1'));
});

test('a re-key leaves what main already said under the new id', () => {
  /* Given */
  const both = run(initial(),
    { type: 'remoteStatus', sessionId: 's1', status: { phase: 'connecting' }, receivedAt: 5 },
    { type: 'remoteStatus', sessionId: 's2', status: { phase: 'connected' }, receivedAt: 6 });

  /* When */
  const state = run(both, SAMPLES.sessionForked);

  /* Then */
  assert.strictEqual(state.remote.statuses.s2.phase, 'connected');
  assert.ok(!state.remote.statuses.s1);
});

test('a re-key of a session nobody knows changes nothing', () => {
  /* Given */
  const state = initial('other');

  /* When */
  const next = rootReducer(state, SAMPLES.sessionForked);

  /* Then */
  assert.strictEqual(next, state);
});

// ── Local keys ──

test('a session seen for the first time gets a key', () => {
  /* When */
  const state = run(initial(), { type: 'sessionsSeen', sessionIds: ['a', 'b'] });

  /* Then */
  assert.notStrictEqual(state.keys.byId.a, state.keys.byId.b);
});

test('seeing a session again keeps its key', () => {
  /* Given */
  const state = run(initial(), { type: 'sessionsSeen', sessionIds: ['a', 'b'] });

  /* When */
  const next = rootReducer(state, { type: 'sessionsSeen', sessionIds: ['b', 'a'] });

  /* Then */
  assert.strictEqual(next, state);
});

test('the key follows the session across re-keys, and the old id gets a fresh one', () => {
  /* Given */
  const seen = run(initial(), { type: 'sessionsSeen', sessionIds: ['a'] });
  const key = sessionKeyIn(seen.keys, 'a');

  /* When */
  const state = run(seen,
    { type: 'sessionForked', oldId: 'a', newId: 'b' },
    { type: 'sessionForked', oldId: 'b', newId: 'c' },
    // The old transcript shows up again as a row of its own.
    { type: 'sessionsSeen', sessionIds: ['a', 'c'] });

  /* Then */
  assert.strictEqual(sessionKeyIn(state.keys, 'c'), key);
  assert.notStrictEqual(sessionKeyIn(state.keys, 'a'), key);
});

test('the old key wins over one the new id was already given', () => {
  /* Given */
  const seen = run(initial(), { type: 'sessionsSeen', sessionIds: ['a', 'b'] });

  /* When */
  const state = run(seen, { type: 'sessionForked', oldId: 'a', newId: 'b' });

  /* Then */
  assert.strictEqual(state.keys.byId.b, seen.keys.byId.a);
});

test('a session never seen is keyed by its id', () => {
  /* When */
  const key = sessionKeyIn(initial().keys, 'x');

  /* Then */
  assert.strictEqual(key, 'x');
});

// ── View ──

test('viewPatched with nothing that differs changes nothing', () => {
  /* Given */
  const state = initial();

  /* When */
  const next = rootReducer(state, { type: 'viewPatched', patch: { showArchived: false } });

  /* Then */
  assert.strictEqual(next, state);
});

test('viewPatched changes a field that differs', () => {
  /* When */
  const next = run(initial(), { type: 'viewPatched', patch: { showArchived: true } });

  /* Then */
  assert.strictEqual(next.view.showArchived, true);
});

test('ptyStopped drops a session from the running set', () => {
  /* Given */
  const running = run(initial(), { type: 'viewPatched', patch: { activePtyIds: new Set(['s1', 's2']) } });

  /* When */
  const stopped = run(running, { type: 'ptyStopped', sessionId: 's1' });

  /* Then */
  assert.deepStrictEqual([...stopped.view.activePtyIds], ['s2']);
  assert.ok(running.view.activePtyIds.has('s1'), 'the old set is untouched');
});

test('activeSessionChanged sets the session on screen', () => {
  /* When */
  const state = run(initial(), { type: 'activeSessionChanged', sessionId: 's3' });

  /* Then */
  assert.strictEqual(state.view.activeSessionId, 's3');
});

// ── Usage ──

const usageRows = [
  { kind: 'a', label: 'A', model: null, percent: 10, reset: null, severity: 'ok' },
  { kind: 'b', label: 'B', model: null, percent: 70, reset: null, severity: 'ok' },
];

test('usage: a fetch records the rows', () => {
  /* When */
  const fetched = run(initial(), { type: 'usageFetched', rows: usageRows });

  /* Then */
  assert.strictEqual(tightestIn(fetched.usage)?.label, 'B');
});

test('usage: a failure after a fetch keeps the rows', () => {
  /* Given */
  const fetched = run(initial(), { type: 'usageFetched', rows: usageRows });

  /* When */
  const failed = run(fetched, { type: 'usageFailed' });

  /* Then */
  assert.strictEqual(failed, fetched);
});

test('usage: a failure only marks it loaded', () => {
  /* When */
  const failed = run(initial(), { type: 'usageFailed' });

  /* Then */
  assert.deepStrictEqual(failed.usage, { rows: [], loaded: true });
});

// ── What the rows show ──

test('rowActivity derives the classes a row renders', () => {
  /* Given */
  const state = run(initial(), { type: 'questionsAsked', pending: asked('s1', 't1') });

  /* When */
  const activity = rowActivity(state, 's1');

  /* Then */
  assert.deepStrictEqual(activity, { needsAttention: true, responseReady: false, busy: false, agents: [] });
});

test('a turn ending off screen makes the row ready and no longer busy', () => {
  /* Given */
  const before = run(initial('other'), { type: 'cliBusyState', sessionId: 's1', busy: true });

  /* When */
  const after = run(before, { type: 'cliBusyState', sessionId: 's1', busy: false });

  /* Then */
  assert.deepStrictEqual(rowActivity(after, 's1'),
    { needsAttention: false, responseReady: true, busy: false, agents: [] });
});

test('a pending question set makes the row need attention', () => {
  /* When */
  const asking = run(initial(), SAMPLES.questionsAsked);

  /* Then */
  assert.strictEqual(rowActivity(asking, 's1').needsAttention, true);
});

test('a settled question set clears needs-attention', () => {
  /* Given */
  const asking = run(initial(), SAMPLES.questionsAsked);

  /* When */
  const settled = run(asking, SAMPLES.questionsSettled);

  /* Then */
  assert.strictEqual(rowActivity(settled, 's1').needsAttention, false);
});

test('a settled question set keeps needs-attention when OSC 9 also asked', () => {
  /* Given */
  const both = run(initial(), SAMPLES.questionsAsked, SAMPLES.sessionNeedsAttention);

  /* When */
  const settled = run(both, SAMPLES.questionsSettled);

  /* Then */
  assert.strictEqual(rowActivity(settled, 's1').needsAttention, true);
});
