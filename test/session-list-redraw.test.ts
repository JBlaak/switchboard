/**
 * What a redraw of the session list leaves alone, and when it may move rows:
 * the session-list slice across `sessionListBuilt`, and the motion rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { redrawGlides } from '../src/renderer/state/list-reflow';
import { isNewScreen } from '../src/renderer/lib/motion/reflow';
import { confettiPieces } from '../src/renderer/lib/motion/celebrate';
import { TIER_REST } from '../src/domain/session/tiers';
import type { ListItem, SessionListGroup, SessionListRow } from '../src/renderer/state/session-list-layout';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

const NOW = 1_700_000_000_000;
const HOUR = 3600000;

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function row(id: string, msAgo = HOUR): SessionListRow {
  return {
    kind: 'row', id: 'si-' + id, projectPath: '/p',
    session: {
      sessionId: id, summary: 'Session ' + id, firstPrompt: '', projectPath: '/p',
      created: new Date(NOW - 2 * HOUR).toISOString(), modified: new Date(NOW - msAgo).toISOString(),
      messageCount: 1, name: null, starred: 0, archived: 0,
    },
  };
}

function item(entry: SessionListRow | SessionListGroup, msAgo = HOUR): ListItem {
  return { entry, sortTime: NOW - msAgo, startTime: NOW - msAgo, pinned: false, pinnedPlan: false, tier: TIER_REST, remote: false };
}

const group: SessionListGroup = { kind: 'group', id: 'slug-g', slug: 'g', projectPath: '/p', sessions: [row('b'), row('c')] };
const OLD = 30 * 24 * HOUR;

/** One redraw of a list holding a row, a slug group and a row old enough to fold away. */
function redraw(): RendererEvent {
  return {
    type: 'sessionListBuilt', items: [item(row('a')), item(group), item(row('old', OLD), OLD)],
    activeItemId: null, resort: false, filtering: false, visibleSessionCount: 25, sessionMaxAgeDays: 3, now: NOW,
  };
}

// ── What a redraw keeps ──

test('a redraw keeps an expanded slug group expanded', () => {
  /* Given */
  const state = run(initialRendererState(), redraw(), { type: 'slugGroupToggled', id: 'slug-g' });

  /* When */
  const next = run(state, redraw());

  /* Then */
  assert.deepEqual(next.sessionList.expandedSlugs, { 'slug-g': true });
});

test('a redraw keeps a group expanded through its "+ N more"', () => {
  /* Given */
  const state = run(initialRendererState(), redraw(), { type: 'slugGroupExpanded', id: 'slug-g' });

  /* When */
  const next = run(state, redraw());

  /* Then */
  assert.deepEqual(next.sessionList.expandedSlugs, { 'slug-g': true });
});

test('a redraw keeps the expanded older list', () => {
  /* Given */
  const state = run(initialRendererState(), redraw(), { type: 'olderToggled' });

  /* When */
  const next = run(state, redraw());

  /* Then */
  assert.equal(next.sessionList.olderExpanded, true);
});

test('a redraw keeps the keyboard cursor', () => {
  /* Given */
  const state = run(initialRendererState(), redraw(), { type: 'listCursorMoved', target: 'si-a' });

  /* When */
  const next = run(state, redraw());

  /* Then */
  assert.equal(next.sessionList.cursor, 'si-a');
});

test('a redraw keeps an open rename', () => {
  /* Given */
  const state = run(initialRendererState(), redraw(), { type: 'renameStarted', rowId: 'si-a' });

  /* When */
  const next = run(state, redraw());

  /* Then */
  assert.equal(next.sessionList.renaming, 'si-a');
});

test('a redraw keeps a row that is still listed leaving', () => {
  /* Given */
  const state = run(initialRendererState(), redraw(), { type: 'rowLeaving', id: 'si-a', leaving: true });

  /* When */
  const next = run(state, redraw());

  /* Then */
  assert.deepEqual(next.sessionList.leaving, { 'si-a': true });
});

// ── When rows move ──

test('nothing glides on the first render', () => {
  /* Given */
  const before = initialRendererState();

  /* When */
  const glides = redrawGlides(before, run(before, redraw()));

  /* Then */
  assert.equal(glides, false);
});

test('a later redraw glides', () => {
  /* Given */
  const before = run(initialRendererState(), redraw());

  /* When */
  const glides = redrawGlides(before, run(before, redraw()));

  /* Then */
  assert.equal(glides, true);
});

test('nothing glides while the sidebar is collapsed', () => {
  /* Given */
  const before = run(initialRendererState(), redraw(), { type: 'sidebarCollapsed', collapsed: true });

  /* When */
  const glides = redrawGlides(before, run(before, redraw()));

  /* Then */
  assert.equal(glides, false);
});

test('more than 12 rows arriving or leaving at once is a new screen, which nothing glides into', () => {
  /* When */
  const screens = [isNewScreen(12, 12), isNewScreen(13, 0), isNewScreen(0, 13)];

  /* Then */
  assert.deepEqual(screens, [false, true, true]);
});

test('archiving throws confetti, and more of it every fifth time', () => {
  /* When */
  const pieces = [1, 2, 3, 4, 5, 6, 10].map(confettiPieces);

  /* Then */
  assert.deepEqual(pieces, [28, 28, 28, 28, 70, 28, 70]);
});
