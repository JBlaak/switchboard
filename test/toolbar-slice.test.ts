import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

function run(...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), initialRendererState());
}

const filters = (state: RendererState) => {
  const { showArchived, showStarredOnly, showRunningOnly, showTodayOnly } = state.view;
  return { showArchived, showStarredOnly, showRunningOnly, showTodayOnly };
};

// ── Filters ──

test('archived replaces pinned', () => {
  /* When */
  const state = run(
    { type: 'filterToggled', filter: 'pinned' },
    { type: 'filterToggled', filter: 'archived' },
  );

  /* Then */
  assert.deepStrictEqual(filters(state), {
    showArchived: true, showStarredOnly: false, showRunningOnly: false, showTodayOnly: false,
  });
});

test('running replaces archived', () => {
  /* Given */
  const state = run(
    { type: 'filterToggled', filter: 'pinned' },
    { type: 'filterToggled', filter: 'archived' },
  );

  /* When */
  const running = rootReducer(state, { type: 'filterToggled', filter: 'running' });

  /* Then */
  assert.deepStrictEqual(filters(running), {
    showArchived: false, showStarredOnly: false, showRunningOnly: true, showTodayOnly: false,
  });
});

test('snoozed replaces running', () => {
  /* Given */
  const state = run({ type: 'filterToggled', filter: 'running' });

  /* When */
  const snoozed = rootReducer(state, { type: 'filterToggled', filter: 'snoozed' });

  /* Then */
  assert.deepStrictEqual(filters(snoozed), {
    showArchived: false, showStarredOnly: false, showRunningOnly: false, showTodayOnly: false,
  });
  assert.strictEqual(snoozed.view.showSnoozedOnly, true);
});

test('toggling the active exclusive filter turns it off', () => {
  /* When */
  const state = run(
    { type: 'filterToggled', filter: 'running' },
    { type: 'filterToggled', filter: 'running' },
  );

  /* Then */
  assert.strictEqual(state.view.showRunningOnly, false);
});

test('today stacks with an exclusive filter and survives a switch between them', () => {
  /* When */
  const state = run(
    { type: 'filterToggled', filter: 'today' },
    { type: 'filterToggled', filter: 'pinned' },
    { type: 'filterToggled', filter: 'archived' },
  );

  /* Then */
  assert.deepStrictEqual(filters(state), {
    showArchived: true, showStarredOnly: false, showRunningOnly: false, showTodayOnly: true,
  });
});

test('toggling today again turns it off', () => {
  /* Given */
  const state = run(
    { type: 'filterToggled', filter: 'today' },
    { type: 'filterToggled', filter: 'pinned' },
    { type: 'filterToggled', filter: 'archived' },
  );

  /* When */
  const next = rootReducer(state, { type: 'filterToggled', filter: 'today' });

  /* Then */
  assert.strictEqual(next.view.showTodayOnly, false);
});

// ── Search ──

test('a search result sets the matches', () => {
  /* Given */
  const ids = new Set(['a', 'b']);
  const paths = new Set(['/p']);

  /* When */
  const matched = run({ type: 'searchMatched', ids, projectPaths: paths });

  /* Then */
  assert.strictEqual(matched.view.searchMatchIds, ids);
  assert.strictEqual(matched.view.searchMatchProjectPaths, paths);
});

test('a dropped search result clears the matches', () => {
  /* Given */
  const matched = run({ type: 'searchMatched', ids: new Set(['a', 'b']), projectPaths: new Set(['/p']) });

  /* When */
  const cleared = rootReducer(matched, { type: 'searchMatched', ids: null, projectPaths: null });

  /* Then */
  assert.strictEqual(cleared.view.searchMatchIds, null);
  assert.strictEqual(cleared.view.searchMatchProjectPaths, null);
});

test('clearing a search that is not there notifies nobody', () => {
  /* Given */
  const state = initialRendererState();

  /* When */
  const next = rootReducer(state, { type: 'searchMatched', ids: null, projectPaths: null });

  /* Then */
  assert.strictEqual(next, state);
});

test('the typed query and the titles-only mode are kept as given', () => {
  /* When */
  const state = run(
    { type: 'searchTyped', query: '  login ' },
    { type: 'searchTitlesOnlyChanged', titlesOnly: true },
  );

  /* Then */
  assert.strictEqual(state.toolbar.searchQuery, '  login ');
  assert.strictEqual(state.toolbar.searchTitlesOnly, true);
  // Typing changes nothing the list reads until the query has run.
  assert.strictEqual(state.view.searchMatchIds, null);
});

// ── The rest of the chrome ──

test('starts open, on the default appearance, with no sleep answer yet', () => {
  /* When */
  const { toolbar } = initialRendererState();

  /* Then */
  assert.strictEqual(toolbar.sidebarCollapsed, false);
  assert.strictEqual(toolbar.appearance, 'system');
  assert.strictEqual(toolbar.sleepDisabled, null);
  assert.strictEqual(toolbar.sleepPending, false);
  assert.strictEqual(toolbar.quickSessionPath, '');
});

test('each chrome event sets its own field', () => {
  /* When */
  const state = run(
    { type: 'sidebarCollapsed', collapsed: true },
    { type: 'projectsLoading', loading: true },
    { type: 'appearanceChanged', mode: 'dark' },
    { type: 'sleepStateRead', disabled: true },
    { type: 'sleepSwitchPending', pending: true },
    { type: 'quickSessionPathRead', path: '/tmp' },
  );

  /* Then */
  assert.deepStrictEqual(state.toolbar, {
    sidebarCollapsed: true,
    projectsLoading: true,
    hasProjects: null,
    searchQuery: '',
    searchTitlesOnly: false,
    appearance: 'dark',
    sleepDisabled: true,
    sleepPending: true,
    quickSessionPath: '/tmp',
  });
});

test('whether there are projects is unknown until a list is counted, then follows it', () => {
  /* When */
  const unknown = run();
  const empty = run({ type: 'projectsCounted', any: false });
  const some = run({ type: 'projectsCounted', any: false }, { type: 'projectsCounted', any: true });

  /* Then */
  assert.strictEqual(unknown.toolbar.hasProjects, null);
  assert.strictEqual(empty.toolbar.hasProjects, false);
  assert.strictEqual(some.toolbar.hasProjects, true);
});

test('writing a chrome field back unchanged keeps the same state', () => {
  /* Given */
  const state = run({ type: 'sidebarCollapsed', collapsed: true });

  /* When */
  const next = rootReducer(state, { type: 'sidebarCollapsed', collapsed: true });

  /* Then */
  assert.strictEqual(next, state);
});
