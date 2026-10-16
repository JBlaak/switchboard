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
  return { entry, sortTime: NOW - msAgo, pinned: false, tier, remote: false };
}

function built(items: ListItem[], extra: Partial<Extract<RendererEvent, { type: 'sessionListBuilt' }>> = {}): RendererEvent {
  return {
    type: 'sessionListBuilt', items, activeItemId: null, resort: false, filtering: false,
    visibleSessionCount: 25, sessionMaxAgeDays: 3, now: NOW, ...extra,
  };
}

const visibleIds = (state: RendererState): string[] => state.sessionList.layout!.visible.map(l => l.entry.id);

test('a redraw anchors the open row against the order of the one before', () => {
  const first = run(initialRendererState(), built([
    item(row('a', HOUR), TIER_READY, HOUR), item(row('b', 2 * HOUR), TIER_READY, 2 * HOUR),
  ], { activeItemId: 'si-a' }));
  assert.deepEqual(visibleIds(first), ['si-a', 'si-b']);

  // b is now the newest, a is open: a stays put until a re-sort.
  const newer = [item(row('a', HOUR), TIER_READY, HOUR), item(row('b', 0), TIER_READY, 0)];
  const second = run(first, built(newer, { activeItemId: 'si-a' }));
  assert.deepEqual(visibleIds(second), ['si-a', 'si-b']);
  assert.deepEqual(visibleIds(run(second, built(newer, { activeItemId: 'si-a', resort: true }))), ['si-b', 'si-a']);
  assert.equal(second.sessionList.revision, 2);
});

test('the group holding the open session is expanded by a redraw', () => {
  const group: SessionListGroup = { kind: 'group', id: 'slug-g', slug: 'g', projectPath: '/p', sessions: [row('a'), row('b')] };
  const collapsed = run(initialRendererState(), built([item(group)]));
  assert.deepEqual(collapsed.sessionList.expandedSlugs, {});
  const opened = run(collapsed, built([item(group)], { activeItemId: 'slug-g' }));
  assert.deepEqual(opened.sessionList.expandedSlugs, { 'slug-g': true });
});

test('slug groups toggle, expand and restore', () => {
  let state = run(initialRendererState(), { type: 'slugGroupsRestored', ids: ['slug-a'] });
  assert.deepEqual(state.sessionList.expandedSlugs, { 'slug-a': true });
  state = run(state, { type: 'slugGroupToggled', id: 'slug-a' }, { type: 'slugGroupToggled', id: 'slug-b' });
  assert.deepEqual(state.sessionList.expandedSlugs, { 'slug-b': true });
  const same = run(state, { type: 'slugGroupExpanded', id: 'slug-b' });
  assert.equal(same, state);
});

test('the older list folds again once there is nothing behind it', () => {
  const old = 30 * 24 * HOUR;
  let state = run(initialRendererState(), built([item(row('a')), item(row('b', old), TIER_REST, old)]), { type: 'olderToggled' });
  assert.equal(state.sessionList.olderExpanded, true);
  state = run(state, built([item(row('a')), item(row('b', old), TIER_REST, old)]));
  assert.equal(state.sessionList.olderExpanded, true, 'a redraw keeps it open');
  state = run(state, built([item(row('a'))]));
  assert.equal(state.sessionList.olderExpanded, false);
});

test('a row that finished leaving is forgotten once it is no longer listed', () => {
  let state = run(initialRendererState(), built([item(row('a')), item(row('b'))]),
    { type: 'rowLeaving', id: 'si-a', leaving: true });
  state = run(state, built([item(row('a')), item(row('b'))]));
  assert.deepEqual(state.sessionList.leaving, { 'si-a': true }, 'still listed, still leaving');
  state = run(state, built([item(row('b'))]));
  assert.deepEqual(state.sessionList.leaving, {});
});

test('a rename patches the layout without counting as a redraw', () => {
  const group: SessionListGroup = { kind: 'group', id: 'slug-g', slug: 'g', projectPath: '/p', sessions: [row('b'), row('c')] };
  const state = run(initialRendererState(), built([item(row('a')), item(group)]));
  const renamed = run(state, { type: 'sessionRenamed', sessionId: 'c', name: 'New name' });
  assert.equal(renamed.sessionList.revision, state.sessionList.revision);
  const entry = renamed.sessionList.layout!.visible[1].entry as SessionListGroup;
  assert.equal(entry.sessions[1].session.name, 'New name');
  assert.equal(run(renamed, { type: 'sessionRenamed', sessionId: 'nobody', name: 'x' }), renamed);
});

test('rename, cursor and the clock', () => {
  let state = run(initialRendererState(), { type: 'renameStarted', rowId: 'si-a' });
  assert.equal(state.sessionList.renaming, 'si-a');
  assert.equal(run(state, { type: 'renameEnded', rowId: 'si-b' }), state, 'another row ending changes nothing');
  state = run(state, { type: 'renameEnded', rowId: 'si-a' }, { type: 'listCursorMoved', target: 'header:slug-g' });
  assert.equal(state.sessionList.renaming, null);
  assert.equal(state.sessionList.cursor, 'header:slug-g');
  assert.equal(run(state, { type: 'sessionListTicked', now: 5 }).sessionList.now, 5);
});

test('a re-key leaves the list state alone: it is keyed by element ids', () => {
  const state = run(initialRendererState(), built([item(row('a'))]), { type: 'renameStarted', rowId: 'si-a' });
  const rekeyed = run(state, { type: 'sessionForked', oldId: 'a', newId: 'a2' });
  assert.equal(rekeyed.sessionList, state.sessionList);
});
