/**
 * The Plan view without a session (#128, F2): it opens on a plan picked in
 * the picker, and closes whenever anything else takes the main area.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rekeyState, rootReducer } from '../src/renderer/state/root';
import { planPageOwner } from '../src/renderer/state/plan-page-slice';
import type { PlanPage } from '../src/renderer/state/plan-page-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const PAGE: PlanPage = { projectPath: '/dev/app', repository: 'acme/app', number: 121 };

function opened(): RendererState {
  return run(initialRendererState('s1'), { type: 'planPageOpened', page: PAGE });
}

test('a plan picked in the picker opens the page for it, in its project', () => {
  /* When */
  const state = opened();

  /* Then */
  assert.deepEqual(state.planPage.open, PAGE);
});

test('opening the same plan again changes nothing', () => {
  /* Given */
  const state = opened();

  /* When */
  const again = run(state, { type: 'planPageOpened', page: { ...PAGE } });

  /* Then */
  assert.equal(again, state);
});

test('Close or Esc closes the page', () => {
  /* When */
  const state = run(opened(), { type: 'planPageClosed' });

  /* Then */
  assert.equal(state.planPage.open, null);
});

for (const [what, event] of [
  ['a session put on screen', { type: 'sessionShown', sessionId: 's2', name: 'Other' }],
  ['the empty screen', { type: 'activeSessionChanged', sessionId: null }],
  ['the settings panel', {
    type: 'settingsOpened', scope: 'global', projectPath: null, current: {}, globalSettings: {}, shellProfiles: [], appVersion: null,
  }],
  ['the Session work page', { type: 'sessionWorkOpened', sessionId: 's1', name: 'One', at: 0 }],
] as const) {
  test(`${what} taking the main area closes the page`, () => {
    /* Given */
    const state = opened();

    /* When */
    const next = run(state, event as RendererEvent);

    /* Then */
    assert.equal(next.planPage.open, null);
  });
}

test('a re-keyed session leaves the page open', () => {
  /* Given */
  const state = opened();

  /* When */
  const next = rekeyState(state, 's1', 's1-new');

  /* Then */
  assert.equal(next.planPage, state.planPage);
});

test('the page’s plan view has an owner of its own, apart from the Plan tab’s', () => {
  /* When */
  const owner = planPageOwner(PAGE);

  /* Then */
  assert.equal(owner, 'plan:acme/app#121');
  assert.ok(!owner.startsWith('session-work:'));
});
