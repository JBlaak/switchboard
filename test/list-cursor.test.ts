import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cursorTargets, headerTarget, rowOrder, shownTargets, startTarget, stepTarget, targetAfterRemoval,
} from '../src/renderer/state/list-cursor';
import { initialSessionListState } from '../src/renderer/state/session-list-slice';
import { TIER_REST } from '../src/domain/session/tiers';
import type { SessionListState } from '../src/renderer/state/session-list-slice';
import type { LaidEntry, SessionListGroup, SessionListRow } from '../src/renderer/state/session-list-layout';
import type { SessionRow } from '../src/domain/session/session';

function session(id: string): SessionRow {
  return {
    sessionId: id, summary: 'Session ' + id, firstPrompt: '', projectPath: '/p',
    created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z',
    messageCount: 1, name: null, starred: 0, archived: 0,
  };
}

function row(id: string): SessionListRow {
  return { kind: 'row', id: 'si-' + id, session: session(id), projectPath: '/p' };
}

function group(id: string, ...ids: string[]): SessionListGroup {
  return { kind: 'group', id, slug: id, projectPath: '/p', sessions: ids.map(row) };
}

const laid = (entry: SessionListRow | SessionListGroup): LaidEntry => ({ entry, tier: TIER_REST });

function list(
  visible: (SessionListRow | SessionListGroup)[],
  older: (SessionListRow | SessionListGroup)[] = [],
  extra: Partial<SessionListState> = {},
): SessionListState {
  return {
    ...initialSessionListState,
    layout: { visible: visible.map(laid), older: older.map(laid), filtering: false },
    ...extra,
  };
}

const NONE = new Set<string>();

test('no layout yet, nothing to land on', () => {
  assert.deepEqual(cursorTargets(initialSessionListState, NONE), []);
});

test('the targets run in render order; a folded group and a closed older list hide their rows', () => {
  const state = list([row('a'), group('slug-g', 'b', 'c'), row('d')], [row('e')]);
  const targets = cursorTargets(state, NONE);
  assert.deepEqual(targets.map(t => t.name), ['si-a', 'header:slug-g', 'si-b', 'si-c', 'si-d', 'older-all', 'si-e']);
  assert.deepEqual(shownTargets(targets), ['si-a', 'header:slug-g', 'si-d', 'older-all']);
  assert.deepEqual(rowOrder(targets), ['a', 'b', 'c', 'd', 'e'], 'navigation between sessions counts hidden rows too');
});

test('an open group and an open older list show them', () => {
  const state = list([group('slug-g', 'b', 'c')], [row('e')], { expandedSlugs: { 'slug-g': true }, olderExpanded: true });
  assert.deepEqual(shownTargets(cursorTargets(state, NONE)), ['header:slug-g', 'si-b', 'si-c', 'older-all', 'si-e']);
});

test('a group puts its running rows first; its "more" toggle never shows', () => {
  const g = group('slug-g', 'b', 'c', 'd');
  const running = new Set(['c']);
  const folded = cursorTargets(list([g]), running);
  assert.deepEqual(folded.map(t => t.name), ['header:slug-g', 'si-c', 'sgm-slug-g', 'si-b', 'si-d']);
  assert.deepEqual(rowOrder(folded), ['c', 'b', 'd']);
  assert.deepEqual(shownTargets(folded), ['header:slug-g']);
  const open = cursorTargets(list([g], [], { expandedSlugs: { 'slug-g': true } }), running);
  assert.deepEqual(shownTargets(open), ['header:slug-g', 'si-c', 'si-b', 'si-d']);
});

test('anything sliding out is skipped, a group with all its rows', () => {
  const state = list([row('a'), group('slug-g', 'b'), row('c')], [], {
    expandedSlugs: { 'slug-g': true },
    leaving: { 'si-a': true, 'slug-g': true },
  });
  assert.deepEqual(shownTargets(cursorTargets(state, NONE)), ['si-c']);
});

test('Cmd+L starts on the cursor, else the open row, else the top', () => {
  const state = list([row('a'), row('b'), row('c')]);
  const targets = cursorTargets(state, NONE);
  assert.equal(startTarget(state, targets, null), 'si-a');
  assert.equal(startTarget(state, targets, 'b'), 'si-b');
  assert.equal(startTarget({ ...state, cursor: 'si-c' }, targets, 'b'), 'si-c');
  // A cursor left on a row that has gone is no cursor.
  assert.equal(startTarget({ ...state, cursor: 'si-gone' }, targets, 'b'), 'si-b');
  assert.equal(startTarget(list([]), [], null), null);
});

test('a step is clamped at both ends, and starts at the top from nowhere', () => {
  const shown = ['a', 'b', 'c'];
  assert.equal(stepTarget(shown, 'b', 1), 'c');
  assert.equal(stepTarget(shown, 'c', 1), 'c');
  assert.equal(stepTarget(shown, 'a', -1), 'a');
  assert.equal(stepTarget(shown, null, -1), 'a');
  assert.equal(stepTarget(shown, 'hidden', 1), 'a');
  assert.equal(stepTarget([], null, 1), null);
});

test('after a removal the cursor goes down, else up, else nowhere', () => {
  assert.equal(targetAfterRemoval(['a', 'b', 'c'], 'b', ['a', 'c']), 'c');
  assert.equal(targetAfterRemoval(['a', 'b', 'c'], 'c', ['a', 'b']), 'b');
  // A group takes its rows with it: the next survivor below.
  assert.equal(targetAfterRemoval(['a', 'g', 'g1', 'g2', 'd'], 'g', ['a', 'd']), 'd');
  assert.equal(targetAfterRemoval(['a'], 'a', []), null);
});

test('headers are named after their group', () => {
  assert.equal(headerTarget('slug-x'), 'header:slug-x');
});
