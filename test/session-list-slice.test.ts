import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { TIER_READY, TIER_REST } from '../src/domain/session/tiers';
import type { ListItem, SessionListGroup, SessionListRow } from '../src/renderer/state/session-list-layout';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { SessionRow } from '../src/domain/session/session';

const NOW = 1_700_000_000_000;
const HOUR = 3600000;

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function session(id: string, msAgo = HOUR): SessionRow {
  return {
    sessionId: id, summary: 'Session ' + id, firstPrompt: '', projectPath: '/p',
    created: new Date(NOW - 2 * HOUR).toISOString(), modified: new Date(NOW - msAgo).toISOString(),
    messageCount: 1, name: null, starred: 0, archived: 0,
  };
}

function row(id: string, msAgo = HOUR): SessionListRow {
  return { kind: 'row', id: 'si-' + id, session: session(id, msAgo), projectPath: '/p' };
}

function item(entry: SessionListRow | SessionListGroup, tier = TIER_REST, msAgo = HOUR): ListItem {
  return { entry, sortTime: NOW - msAgo, startTime: NOW - msAgo, pinned: false, tier, remote: false };
}

function built(items: ListItem[], extra: Partial<Extract<RendererEvent, { type: 'sessionListBuilt' }>> = {}): RendererEvent {
  return {
    type: 'sessionListBuilt', items, activeItemId: null, resort: false, filtering: false,
    visibleSessionCount: 25, sessionMaxAgeDays: 3, now: NOW, ...extra,
  };
}

const visibleIds = (state: RendererState): string[] => state.sessionList.layout!.visible.map(l => l.entry.id);

const firstDraw = (): RendererState => run(initialRendererState(), built([
  item(row('a', HOUR), TIER_READY, HOUR), item(row('b', 2 * HOUR), TIER_READY, 2 * HOUR),
], { activeItemId: 'si-a' }));

// b is now the newest, a is open: a stays put until a re-sort.
const newerDraw = (resort = false): RendererEvent =>
  built([item(row('a', HOUR), TIER_READY, HOUR), item(row('b', 0), TIER_READY, 0)], { activeItemId: 'si-a', resort });

test('a first draw lists rows newest first', () => {
  /* When */
  const first = firstDraw();

  /* Then */
  assert.deepEqual(visibleIds(first), ['si-a', 'si-b']);
});

test('a redraw anchors the open row against the order of the one before', () => {
  /* Given */
  const first = firstDraw();

  /* When */
  const second = run(first, newerDraw());

  /* Then */
  assert.deepEqual(visibleIds(second), ['si-a', 'si-b']);
  assert.equal(second.sessionList.revision, 2);
});

test('a re-sorting redraw lets the open row move', () => {
  /* Given */
  const second = run(firstDraw(), newerDraw());

  /* When */
  const resorted = run(second, newerDraw(true));

  /* Then */
  assert.deepEqual(visibleIds(resorted), ['si-b', 'si-a']);
});

const group = (...ids: string[]): SessionListGroup =>
  ({ kind: 'group', id: 'slug-g', slug: 'g', projectPath: '/p', sessions: ids.map(id => row(id)) });

test('a group starts collapsed', () => {
  /* When */
  const collapsed = run(initialRendererState(), built([item(group('a', 'b'))]));

  /* Then */
  assert.deepEqual(collapsed.sessionList.expandedSlugs, {});
});

test('the group holding the open session is expanded by a redraw', () => {
  /* Given */
  const collapsed = run(initialRendererState(), built([item(group('a', 'b'))]));

  /* When */
  const opened = run(collapsed, built([item(group('a', 'b'))], { activeItemId: 'slug-g' }));

  /* Then */
  assert.deepEqual(opened.sessionList.expandedSlugs, { 'slug-g': true });
});

test('slug groups are restored expanded', () => {
  /* When */
  const state = run(initialRendererState(), { type: 'slugGroupsRestored', ids: ['slug-a'] });

  /* Then */
  assert.deepEqual(state.sessionList.expandedSlugs, { 'slug-a': true });
});

test('slug groups toggle', () => {
  /* Given */
  const restored = run(initialRendererState(), { type: 'slugGroupsRestored', ids: ['slug-a'] });

  /* When */
  const state = run(restored, { type: 'slugGroupToggled', id: 'slug-a' }, { type: 'slugGroupToggled', id: 'slug-b' });

  /* Then */
  assert.deepEqual(state.sessionList.expandedSlugs, { 'slug-b': true });
});

test('expanding an expanded slug group changes nothing', () => {
  /* Given */
  const state = run(initialRendererState(), { type: 'slugGroupToggled', id: 'slug-b' });

  /* When */
  const same = run(state, { type: 'slugGroupExpanded', id: 'slug-b' });

  /* Then */
  assert.equal(same, state);
});

test('the older list folds again once there is nothing behind it', () => {
  /* Given */
  const old = 30 * 24 * HOUR;
  const withOlder = () => built([item(row('a')), item(row('b', old), TIER_REST, old)]);

  /* When */
  let state = run(initialRendererState(), withOlder(), { type: 'olderToggled' });

  /* Then */
  assert.equal(state.sessionList.olderExpanded, true);

  /* When */
  state = run(state, withOlder());

  /* Then */
  assert.equal(state.sessionList.olderExpanded, true, 'a redraw keeps it open');

  /* When */
  state = run(state, built([item(row('a'))]));

  /* Then */
  assert.equal(state.sessionList.olderExpanded, false);
});

test('a row that finished leaving is forgotten once it is no longer listed', () => {
  /* Given */
  let state = run(initialRendererState(), built([item(row('a')), item(row('b'))]),
    { type: 'rowLeaving', id: 'si-a', leaving: true });

  /* When */
  state = run(state, built([item(row('a')), item(row('b'))]));

  /* Then */
  assert.deepEqual(state.sessionList.leaving, { 'si-a': true }, 'still listed, still leaving');

  /* When */
  state = run(state, built([item(row('b'))]));

  /* Then */
  assert.deepEqual(state.sessionList.leaving, {});
});

const listedForRename = (): RendererState => run(initialRendererState(), built([item(row('a')), item(group('b', 'c'))]));

test('a rename patches the layout without counting as a redraw', () => {
  /* Given */
  const state = listedForRename();

  /* When */
  const renamed = run(state, { type: 'sessionRenamed', sessionId: 'c', name: 'New name' });

  /* Then */
  assert.equal(renamed.sessionList.revision, state.sessionList.revision);
  const entry = renamed.sessionList.layout!.visible[1].entry as SessionListGroup;
  assert.equal(entry.sessions[1].session.name, 'New name');
});

test('renaming a session that is not listed changes nothing', () => {
  /* Given */
  const state = listedForRename();

  /* When */
  const renamed = run(state, { type: 'sessionRenamed', sessionId: 'nobody', name: 'x' });

  /* Then */
  assert.equal(renamed, state);
});

test('starting a rename marks the row being renamed', () => {
  /* When */
  const state = run(initialRendererState(), { type: 'renameStarted', rowId: 'si-a' });

  /* Then */
  assert.equal(state.sessionList.renaming, 'si-a');
});

test('another row ending a rename changes nothing', () => {
  /* Given */
  const state = run(initialRendererState(), { type: 'renameStarted', rowId: 'si-a' });

  /* When */
  const next = run(state, { type: 'renameEnded', rowId: 'si-b' });

  /* Then */
  assert.equal(next, state, 'another row ending changes nothing');
});

test('ending the rename clears it', () => {
  /* Given */
  const state = run(initialRendererState(), { type: 'renameStarted', rowId: 'si-a' });

  /* When */
  const next = run(state, { type: 'renameEnded', rowId: 'si-a' });

  /* Then */
  assert.equal(next.sessionList.renaming, null);
});

test('the list cursor moves', () => {
  /* When */
  const state = run(initialRendererState(), { type: 'listCursorMoved', target: 'header:slug-g' });

  /* Then */
  assert.equal(state.sessionList.cursor, 'header:slug-g');
});

test('a tick moves the list clock', () => {
  /* When */
  const state = run(initialRendererState(), { type: 'sessionListTicked', now: 5 });

  /* Then */
  assert.equal(state.sessionList.now, 5);
});

test('a re-key leaves the list state alone: it is keyed by element ids', () => {
  /* Given */
  const state = run(initialRendererState(), built([item(row('a'))]), { type: 'renameStarted', rowId: 'si-a' });

  /* When */
  const rekeyed = run(state, { type: 'sessionForked', oldId: 'a', newId: 'a2' });

  /* Then */
  assert.equal(rekeyed.sessionList, state.sessionList);
});
