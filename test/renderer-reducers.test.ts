import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { busyChanged } from '../src/renderer/state/activity-slice';
import { sessionsInFlightIn } from '../src/renderer/state/remote-slice';
import { tightestIn } from '../src/renderer/state/usage-slice';
import { rowActivity, rowActivityChanges } from '../src/renderer/state/row-activity';
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
};

test('every push event reduces without mutating the state it was given', () => {
  for (const event of Object.values(SAMPLES)) {
    assert.doesNotThrow(() => rootReducer(deepFreeze(initial()), event), event.type);
  }
});

test('pushes that are only prompts to act leave the state as it was', () => {
  // These have follow-ups (a banner, a re-fetch, a class on <html>) but
  // nothing for the store to record. The status line and the update notice
  // are in the store now; see footer-slices.test.ts.
  for (const type of ['processExited', 'projectsChanged', 'fullscreenChanged'] as const) {
    const state = initial();
    assert.strictEqual(rootReducer(state, SAMPLES[type]), state, type);
  }
});

// ── cliBusyState ──

test('a turn starting marks the session busy', () => {
  const state = run(initial(), { type: 'cliBusyState', sessionId: 's1', busy: true });
  assert.strictEqual(state.activity.busy.s1, true);
  assert.ok(!state.activity.ready.s1);
});

test('a turn ending off screen leaves the answer unread', () => {
  const state = run(initial('other'),
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'cliBusyState', sessionId: 's1', busy: false });
  assert.strictEqual(state.activity.busy.s1, false);
  assert.strictEqual(state.activity.ready.s1, true);
});

test('a turn ending on screen is read by definition', () => {
  const state = run(initial('s1'),
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'cliBusyState', sessionId: 's1', busy: false });
  assert.ok(!state.activity.ready.s1);
});

test('a late idle signal does not clear an unread answer', () => {
  const ready = run(initial(),
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'cliBusyState', sessionId: 's1', busy: false });
  assert.strictEqual(run(ready, { type: 'cliBusyState', sessionId: 's1', busy: false }), ready);
});

test('a new turn supersedes an unread answer', () => {
  const state = run(initial(),
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'cliBusyState', sessionId: 's1', busy: false },
    { type: 'cliBusyState', sessionId: 's1', busy: true });
  assert.ok(!state.activity.ready.s1);
  assert.strictEqual(state.activity.busy.s1, true);
});

test('busyChanged reports a real busy↔idle flip only', () => {
  const idle = initial();
  const busy = run(idle, { type: 'cliBusyState', sessionId: 's1', busy: true });
  assert.ok(busyChanged(idle.activity, busy.activity, 's1'));
  assert.ok(!busyChanged(busy.activity, run(busy, SAMPLES.cliBusyState).activity, 's1'));
  // Idle reported for a session never seen busy: false either way.
  assert.ok(!busyChanged(idle.activity, run(idle, { type: 'cliBusyState', sessionId: 's1', busy: false }).activity, 's1'));
});

// ── Attention ──

test('a notification asking for a person marks the session as needing input', () => {
  for (const message of ['needs your attention', 'needs your approval for the plan',
    'needs your permission to use Bash', 'wants to enter plan mode']) {
    const state = run(initial(), { type: 'terminalNotification', sessionId: 's1', message });
    assert.strictEqual(state.activity.attention.s1, true, message);
  }
});

test('"waiting for your input" settles the session instead', () => {
  const state = run(initial('other'),
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'terminalNotification', sessionId: 's1', message: 'Claude is waiting for your input' });
  assert.strictEqual(state.activity.busy.s1, false);
  assert.strictEqual(state.activity.ready.s1, true);
  assert.ok(!state.activity.attention.s1);
});

test('any other notification changes nothing', () => {
  const state = initial();
  assert.strictEqual(rootReducer(state, { type: 'terminalNotification', sessionId: 's1', message: 'Build done' }), state);
});

test('sessionNeedsAttention marks the session, unless it is on screen', () => {
  assert.strictEqual(run(initial(), SAMPLES.sessionNeedsAttention).activity.attention.s1, true);
  const onScreen = initial('s1');
  assert.strictEqual(rootReducer(onScreen, SAMPLES.sessionNeedsAttention), onScreen);
});

test('viewing a session clears its unread and waiting marks, but not its busy state', () => {
  const state = run(initial('other'),
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'cliBusyState', sessionId: 's1', busy: false },
    { type: 'sessionNeedsAttention', sessionId: 's1' },
    { type: 'sessionViewed', sessionId: 's1' });
  assert.ok(!state.activity.ready.s1);
  assert.ok(!state.activity.attention.s1);
  assert.strictEqual(state.activity.busy.s1, false);
});

// ── Agents ──

test('sessionAgents records the working agents, and an empty list forgets them', () => {
  const withAgents = run(initial(), SAMPLES.sessionAgents);
  assert.strictEqual(withAgents.activity.agents.s1, SAMPLES.sessionAgents.agents);
  const cleared = run(withAgents, { type: 'sessionAgents', sessionId: 's1', agents: [] });
  assert.ok(!('s1' in cleared.activity.agents));
});

test('activityCleared drops everything, the agents included', () => {
  const state = run(initial(),
    { type: 'cliBusyState', sessionId: 's1', busy: true },
    { type: 'sessionNeedsAttention', sessionId: 's1' },
    SAMPLES.sessionAgents,
    { type: 'activityCleared', sessionId: 's1' });
  assert.deepStrictEqual(state.activity, { attention: {}, ready: {}, busy: {}, agents: {} });
  // Clearing again is a no-op, so the per-row poll sweep costs nothing.
  assert.strictEqual(rootReducer(state, { type: 'activityCleared', sessionId: 's1' }), state);
});

// ── Remote status ──

test('remoteStatus resolves its timings against when it arrived', () => {
  const connecting = run(initial(), SAMPLES.remoteStatus);
  assert.strictEqual(connecting.remote.statuses.s1.startedAt, 5);
  const retrying = run(connecting, {
    type: 'remoteStatus', sessionId: 's1', status: { phase: 'retrying', delayMs: 2000 }, receivedAt: 100,
  });
  assert.strictEqual(retrying.remote.statuses.s1.retryAt, 2100);
  assert.deepStrictEqual(sessionsInFlightIn(retrying.remote), ['s1']);
});

test('a disconnect, or the terminal going, forgets the status', () => {
  const connecting = run(initial(), SAMPLES.remoteStatus);
  const gone = run(connecting, {
    type: 'remoteStatus', sessionId: 's1', status: { phase: 'disconnected' }, receivedAt: 6,
  });
  assert.deepStrictEqual(gone.remote.statuses, {});
  assert.deepStrictEqual(run(connecting, { type: 'remoteStatusForgotten', sessionId: 's1' }).remote.statuses, {});
});

test('a connected session is no longer in flight', () => {
  const state = run(initial(), SAMPLES.remoteStatus, {
    type: 'remoteStatus', sessionId: 's1', status: { phase: 'connected' }, receivedAt: 6,
  });
  assert.deepStrictEqual(sessionsInFlightIn(state.remote), []);
});

test('remoteTick moves the shared clock', () => {
  assert.strictEqual(run(initial(), { type: 'remoteTick', at: 42 }).remote.tickAt, 42);
});

// ── Questions ──

test('questionsAsked records the set; the same set again is ignored', () => {
  const state = run(initial(), SAMPLES.questionsAsked);
  assert.strictEqual(state.questions.bySession.s1.toolUseId, 't1');
  assert.strictEqual(rootReducer(state, SAMPLES.questionsAsked), state);
  // A different set replaces it.
  assert.strictEqual(run(state, { type: 'questionsAsked', pending: asked('s1', 't2') })
    .questions.bySession.s1.toolUseId, 't2');
});

test('questionsSettled removes the set, found by tool-use id', () => {
  const state = run(initial(), SAMPLES.questionsAsked, {
    type: 'questionsSettled', settled: { sessionId: 'stale-id', toolUseId: 't1', outcome: 'withdrawn' },
  });
  assert.deepStrictEqual(state.questions.bySession, {});
});

test('a set settled before the bootstrap fetch returned it stays settled', () => {
  const state = run(initial(), SAMPLES.questionsSettled, SAMPLES.questionsAsked);
  assert.deepStrictEqual(state.questions.bySession, {});
});

test('sessionForked moves a set to the new id', () => {
  const state = run(initial(), SAMPLES.questionsAsked, SAMPLES.sessionForked);
  assert.ok(!state.questions.bySession.s1);
  assert.strictEqual(state.questions.bySession.s2.sessionId, 's2');
});

test('sessionForked keeps a set main already asked under the new id', () => {
  const state = run(initial(), SAMPLES.questionsAsked,
    { type: 'questionsAsked', pending: asked('s2', 't9') }, SAMPLES.sessionForked);
  assert.strictEqual(state.questions.bySession.s2.toolUseId, 't9');
});

test('sessionForked does not move the session on screen; the IPC follow-up does', () => {
  // It only does so when the session has an open terminal, which the store
  // does not know about.
  const state = run(initial('s1'), SAMPLES.sessionForked);
  assert.strictEqual(state.view.activeSessionId, 's1');
});

// ── View ──

test('viewPatched changes only the fields that differ', () => {
  const state = initial();
  assert.strictEqual(rootReducer(state, { type: 'viewPatched', patch: { showArchived: false } }), state);
  const next = run(state, { type: 'viewPatched', patch: { showArchived: true } });
  assert.strictEqual(next.view.showArchived, true);
});

test('ptyStopped drops a session from the running set', () => {
  const running = run(initial(), { type: 'viewPatched', patch: { activePtyIds: new Set(['s1', 's2']) } });
  const stopped = run(running, { type: 'ptyStopped', sessionId: 's1' });
  assert.deepStrictEqual([...stopped.view.activePtyIds], ['s2']);
  assert.ok(running.view.activePtyIds.has('s1'), 'the old set is untouched');
});

test('activeSessionChanged sets the session on screen', () => {
  assert.strictEqual(run(initial(), { type: 'activeSessionChanged', sessionId: 's3' }).view.activeSessionId, 's3');
});

// ── Usage ──

test('usage: a fetch records the rows; a failure only marks it loaded', () => {
  const rows = [
    { kind: 'a', label: 'A', model: null, percent: 10, reset: null, severity: 'ok' },
    { kind: 'b', label: 'B', model: null, percent: 70, reset: null, severity: 'ok' },
  ];
  const fetched = run(initial(), { type: 'usageFetched', rows });
  assert.strictEqual(tightestIn(fetched.usage)?.label, 'B');
  assert.strictEqual(run(fetched, { type: 'usageFailed' }), fetched);
  assert.deepStrictEqual(run(initial(), { type: 'usageFailed' }).usage, { rows: [], loaded: true });
});

// ── What the rows show ──

test('rowActivity derives the classes the row builder and the sidebar both use', () => {
  const state = run(initial(), { type: 'questionsAsked', pending: asked('s1', 't1') });
  assert.deepStrictEqual(rowActivity(state, 's1'),
    { needsAttention: true, responseReady: false, busy: false, agents: [] });
});

test('rowActivityChanges names only the rows and classes that changed', () => {
  const before = run(initial('other'), { type: 'cliBusyState', sessionId: 's1', busy: true });
  const after = run(before, { type: 'cliBusyState', sessionId: 's1', busy: false });
  assert.deepStrictEqual(rowActivityChanges(before, after).map(c => [c.sessionId, c.classes, c.agentsChanged]),
    [['s1', { 'response-ready': true, 'cli-busy': false }, false]]);
});

test('rowActivityChanges is empty when neither slice moved', () => {
  const state = initial();
  assert.deepStrictEqual(rowActivityChanges(state, run(state, { type: 'remoteTick', at: 1 })), []);
});

test('a settled question set clears needs-attention unless OSC 9 also asked', () => {
  const asking = run(initial(), SAMPLES.questionsAsked);
  const settled = run(asking, SAMPLES.questionsSettled);
  assert.deepStrictEqual(rowActivityChanges(asking, settled)[0].classes, { 'needs-attention': false });

  const both = run(asking, SAMPLES.sessionNeedsAttention);
  assert.deepStrictEqual(rowActivityChanges(both, run(both, SAMPLES.questionsSettled)), []);
});
