/**
 * What the main area shows (#168): one route, the sidebar highlight derived
 * from it, and the session to return to when a project, the settings or a
 * session's work page closes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rekeyState, rootReducer } from '../src/renderer/state/root';
import { highlightedSession, projectPlan, projectPlanOwner } from '../src/renderer/state/main-area-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const PLAN: RendererEvent = {
  type: 'projectOpened', projectPath: '/dev/app', view: { kind: 'plan', repository: 'acme/app', number: 121 },
};

const SETTINGS: RendererEvent = {
  type: 'settingsOpened', scope: 'global', projectPath: null, current: {}, globalSettings: {}, shellProfiles: [], appVersion: null, quickAskRegistered: true, quickAskMissing: [],
};

/** `id` put on screen the way `showSession` does it. */
function shown(id: string): RendererEvent[] {
  return [{ type: 'activeSessionChanged', sessionId: id }, { type: 'sessionShown', sessionId: id, name: id }];
}

function onScreen(id: string): RendererState {
  return run(initialRendererState(), ...shown(id));
}

test('the main area starts on the empty screen, with no row lit, even with a session restored to return to', () => {
  /* When */
  const state = initialRendererState('s1');

  /* Then */
  assert.equal(state.mainArea.route.kind, 'empty');
  assert.equal(highlightedSession(state.mainArea), null);
});

test('a session put on screen is the route, and its row is the one lit', () => {
  /* When */
  const state = onScreen('s1');

  /* Then */
  assert.deepEqual(state.mainArea.route, { kind: 'session', sessionId: 's1' });
  assert.equal(highlightedSession(state.mainArea), 's1');
});

test('opening a plan from the picker lights no row, and keeps the session to return to', () => {
  /* Given */
  const state = onScreen('s1');

  /* When */
  const next = run(state, PLAN);

  /* Then */
  assert.deepEqual(projectPlan(next.mainArea), { projectPath: '/dev/app', repository: 'acme/app', number: 121 });
  assert.equal(highlightedSession(next.mainArea), null);
  assert.equal(next.view.activeSessionId, 's1');
});

test('opening the same plan again changes nothing', () => {
  /* Given */
  const state = run(onScreen('s1'), PLAN);

  /* When */
  const again = run(state, { ...PLAN } as RendererEvent);

  /* Then */
  assert.equal(again, state);
});

test('Esc on a project goes back to the session to return to, lit again', () => {
  /* Given */
  const state = run(onScreen('s1'), PLAN);

  /* When */
  const next = run(state, { type: 'projectClosed' });

  /* Then */
  assert.deepEqual(next.mainArea.route, { kind: 'session', sessionId: 's1' });
  assert.equal(highlightedSession(next.mainArea), 's1');
});

test('back from a plan to its project’s page still lights no row, and Esc there still goes back to the session', () => {
  /* Given */
  const state = run(onScreen('s1'), PLAN);

  /* When */
  const overview = run(state, { type: 'projectOpened', projectPath: '/dev/app', view: { kind: 'overview' } });

  /* Then */
  assert.deepEqual(overview.mainArea.route, { kind: 'project', projectPath: '/dev/app', view: { kind: 'overview' } });
  assert.equal(projectPlan(overview.mainArea), null);
  assert.equal(highlightedSession(overview.mainArea), null);

  /* When */
  const back = run(overview, { type: 'projectClosed' });

  /* Then */
  assert.deepEqual(back.mainArea.route, { kind: 'session', sessionId: 's1' });
});

test('Esc on a project with no session to return to goes to the empty screen', () => {
  /* Given */
  const state = run(initialRendererState(), PLAN);

  /* When */
  const next = run(state, { type: 'projectClosed' });

  /* Then */
  assert.equal(next.mainArea.route.kind, 'empty');
});

test('a sidebar click while a project is open shows that session and closes the project', () => {
  /* Given */
  const state = run(onScreen('s1'), PLAN);

  /* When */
  const next = run(state, ...shown('s2'));

  /* Then */
  assert.deepEqual(next.mainArea.route, { kind: 'session', sessionId: 's2' });
  assert.equal(projectPlan(next.mainArea), null);
});

for (const [what, events, kind] of [
  ['the Session work page', [{ type: 'sessionWorkOpened', sessionId: 's1', name: 'One', at: 0 }], 'sessionWork'],
  ['the app settings', [SETTINGS], 'settings'],
  ['the empty screen', [{ type: 'activeSessionChanged', sessionId: null }, { type: 'screenCleared' }], 'empty'],
] as const) {
  test(`opening ${what} closes a project`, () => {
    /* Given */
    const state = run(onScreen('s1'), PLAN);

    /* When */
    const next = run(state, ...(events as readonly RendererEvent[]));

    /* Then */
    assert.equal(next.mainArea.route.kind, kind);
  });
}

test('opening a project closes the Session work page', () => {
  /* Given */
  const state = run(onScreen('s1'), { type: 'sessionWorkOpened', sessionId: 's1', name: 'One', at: 0 });

  /* When */
  const next = run(state, PLAN);

  /* Then */
  assert.equal(next.sessionWork.page, null);
  assert.equal(next.mainArea.route.kind, 'project');
});

test('the session to return to going away leaves the project open, and Esc then goes to the empty screen', () => {
  /* Given */
  const state = run(onScreen('s1'), PLAN);

  /* When */
  const stopped = run(state, { type: 'activeSessionChanged', sessionId: null });
  const closed = run(stopped, { type: 'projectClosed' });

  /* Then */
  assert.equal(stopped.mainArea.route.kind, 'project');
  assert.equal(closed.mainArea.route.kind, 'empty');
});

test('the session on screen going away leaves the empty screen', () => {
  /* Given */
  const state = onScreen('s1');

  /* When */
  const next = run(state, { type: 'activeSessionChanged', sessionId: null });

  /* Then */
  assert.equal(next.mainArea.route.kind, 'empty');
});

test('closing the settings or a session’s work page goes back to the session to return to', () => {
  /* Given */
  const settings = run(onScreen('s1'), SETTINGS);
  const work = run(onScreen('s1'), { type: 'sessionWorkOpened', sessionId: 's1', name: 'One', at: 0 });

  /* When */
  const fromSettings = run(settings, { type: 'settingsClosed' });
  const fromWork = run(work, { type: 'sessionWorkClosed', sessionId: 's1' });

  /* Then */
  assert.deepEqual(fromSettings.mainArea.route, { kind: 'session', sessionId: 's1' });
  assert.deepEqual(fromWork.mainArea.route, { kind: 'session', sessionId: 's1' });
});

test('a session’s work page keeps its row lit; the settings light none', () => {
  /* Given */
  const state = onScreen('s1');

  /* When */
  const work = run(state, { type: 'sessionWorkOpened', sessionId: 's1', name: 'One', at: 0 });
  const settings = run(state, SETTINGS);

  /* Then */
  assert.equal(highlightedSession(work.mainArea), 's1');
  assert.equal(highlightedSession(settings.mainArea), null);
});

test('a re-keyed session to return to is the one Esc goes back to', () => {
  /* Given */
  const state = run(onScreen('s1'), PLAN);

  /* When */
  const next = run(rekeyState(state, 's1', 's1-new'), { type: 'projectClosed' });

  /* Then */
  assert.deepEqual(next.mainArea.route, { kind: 'session', sessionId: 's1-new' });
});

test('a re-keyed session on screen stays on screen, lit under its new id', () => {
  /* Given */
  const state = onScreen('s1');

  /* When */
  const next = rekeyState(state, 's1', 's1-new');

  /* Then */
  assert.equal(highlightedSession(next.mainArea), 's1-new');
});

test('a session covered by a project is not being looked at, so it can need attention', () => {
  /* Given */
  const state = run(onScreen('s1'), PLAN);

  /* When */
  const next = run(state, { type: 'sessionNeedsAttention', sessionId: 's1' });

  /* Then */
  assert.equal(next.activity.attention.s1, true);
});

test('a project’s plan view has an owner of its own, apart from the Plan tab’s', () => {
  /* When */
  const owner = projectPlanOwner({ repository: 'acme/app', number: 121 });

  /* Then */
  assert.equal(owner, 'plan:acme/app#121');
  assert.ok(!owner.startsWith('session-work:'));
});
