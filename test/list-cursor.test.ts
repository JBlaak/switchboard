import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cursorTargets, headerTarget, rowOrder, shownTargets, startTarget, stepTarget, targetAfterRemoval,
} from '../src/renderer/state/list-cursor';
import { initialSessionListState } from '../src/renderer/state/session-list-slice';
import { TIER_REST } from '../src/domain/session/tiers';
import type { SessionListState } from '../src/renderer/state/session-list-slice';
import type { LaidEntry, SessionListGroup, SessionListPlan, SessionListRow } from '../src/renderer/state/session-list-layout';
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

function plan(id: string): SessionListPlan {
  return { kind: 'plan', id, projectPath: '/p', repository: 'acme/app', number: 12, title: 'Plan' };
}

type Entry = SessionListRow | SessionListGroup | SessionListPlan;

const laid = (entry: Entry): LaidEntry => ({ entry, tier: TIER_REST });

function list(
  visible: Entry[],
  older: Entry[] = [],
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
  /* When */
  const targets = cursorTargets(initialSessionListState, NONE);

  /* Then */
  assert.deepEqual(targets, []);
});

/** A row, a folded group, a row, and a closed older list with one row. */
const mixed = () => list([row('a'), group('slug-g', 'b', 'c'), row('d')], [row('e')]);

test('the targets run in render order', () => {
  /* Given */
  const state = mixed();

  /* When */
  const targets = cursorTargets(state, NONE);

  /* Then */
  assert.deepEqual(targets.map(t => t.name), ['si-a', 'header:slug-g', 'si-b', 'si-c', 'si-d', 'older-all', 'si-e']);
});

test('a pinned GitHub plan is one target that opens its page, and no session', () => {
  /* Given */
  const state = list([plan('plan-x'), row('a')]);

  /* When */
  const targets = cursorTargets(state, NONE);

  /* Then */
  assert.deepEqual(targets[0], {
    kind: 'plan', name: 'plan-x', shown: true, projectPath: '/p', repository: 'acme/app', number: 12,
  });
  assert.deepEqual(rowOrder(targets), ['a']);
});

test('a folded group and a closed older list hide their rows', () => {
  /* Given */
  const targets = cursorTargets(mixed(), NONE);

  /* When */
  const shown = shownTargets(targets);

  /* Then */
  assert.deepEqual(shown, ['si-a', 'header:slug-g', 'si-d', 'older-all']);
});

test('navigation between sessions counts hidden rows too', () => {
  /* Given */
  const targets = cursorTargets(mixed(), NONE);

  /* When */
  const order = rowOrder(targets);

  /* Then */
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e'], 'navigation between sessions counts hidden rows too');
});

test('an open group and an open older list show them', () => {
  /* Given */
  const state = list([group('slug-g', 'b', 'c')], [row('e')], { expandedSlugs: { 'slug-g': true }, olderExpanded: true });

  /* When */
  const shown = shownTargets(cursorTargets(state, NONE));

  /* Then */
  assert.deepEqual(shown, ['header:slug-g', 'si-b', 'si-c', 'older-all', 'si-e']);
});

const threeInGroup = () => group('slug-g', 'b', 'c', 'd');
const cRunning = new Set(['c']);

test('a group puts its running rows first', () => {
  /* Given */
  const state = list([threeInGroup()]);

  /* When */
  const folded = cursorTargets(state, cRunning);

  /* Then */
  assert.deepEqual(folded.map(t => t.name), ['header:slug-g', 'si-c', 'sgm-slug-g', 'si-b', 'si-d']);
  assert.deepEqual(rowOrder(folded), ['c', 'b', 'd']);
});

test('a folded group with running rows shows only its header', () => {
  /* Given */
  const folded = cursorTargets(list([threeInGroup()]), cRunning);

  /* When */
  const shown = shownTargets(folded);

  /* Then */
  assert.deepEqual(shown, ['header:slug-g']);
});

test('an open group shows its running rows first; its "more" toggle never shows', () => {
  /* Given */
  const state = list([threeInGroup()], [], { expandedSlugs: { 'slug-g': true } });

  /* When */
  const open = cursorTargets(state, cRunning);

  /* Then */
  assert.deepEqual(shownTargets(open), ['header:slug-g', 'si-c', 'si-b', 'si-d']);
});

test('anything sliding out is skipped, a group with all its rows', () => {
  /* Given */
  const state = list([row('a'), group('slug-g', 'b'), row('c')], [], {
    expandedSlugs: { 'slug-g': true },
    leaving: { 'si-a': true, 'slug-g': true },
  });

  /* When */
  const shown = shownTargets(cursorTargets(state, NONE));

  /* Then */
  assert.deepEqual(shown, ['si-c']);
});

const abc = () => list([row('a'), row('b'), row('c')]);

test('Cmd+L starts at the top when there is no cursor and no open row', () => {
  /* Given */
  const state = abc();
  const targets = cursorTargets(state, NONE);

  /* When */
  const start = startTarget(state, targets, null);

  /* Then */
  assert.equal(start, 'si-a');
});

test('Cmd+L starts on the open row when there is no cursor', () => {
  /* Given */
  const state = abc();
  const targets = cursorTargets(state, NONE);

  /* When */
  const start = startTarget(state, targets, 'b');

  /* Then */
  assert.equal(start, 'si-b');
});

test('Cmd+L starts on the cursor before the open row', () => {
  /* Given */
  const state = abc();
  const targets = cursorTargets(state, NONE);

  /* When */
  const start = startTarget({ ...state, cursor: 'si-c' }, targets, 'b');

  /* Then */
  assert.equal(start, 'si-c');
});

test('Cmd+L treats a cursor left on a row that has gone as no cursor', () => {
  /* Given */
  const state = abc();
  const targets = cursorTargets(state, NONE);

  /* When */
  const start = startTarget({ ...state, cursor: 'si-gone' }, targets, 'b');

  /* Then */
  assert.equal(start, 'si-b');
});

test('Cmd+L on an empty list starts nowhere', () => {
  /* When */
  const start = startTarget(list([]), [], null);

  /* Then */
  assert.equal(start, null);
});

const SHOWN = ['a', 'b', 'c'];

test('a step moves to the next shown target', () => {
  /* When */
  const next = stepTarget(SHOWN, 'b', 1);

  /* Then */
  assert.equal(next, 'c');
});

test('a step is clamped at both ends', () => {
  /* When */
  const pastBottom = stepTarget(SHOWN, 'c', 1);
  const pastTop = stepTarget(SHOWN, 'a', -1);

  /* Then */
  assert.equal(pastBottom, 'c');
  assert.equal(pastTop, 'a');
});

test('a step starts at the top from nowhere', () => {
  /* When */
  const fromNull = stepTarget(SHOWN, null, -1);
  const fromHidden = stepTarget(SHOWN, 'hidden', 1);

  /* Then */
  assert.equal(fromNull, 'a');
  assert.equal(fromHidden, 'a');
});

test('a step in an empty list goes nowhere', () => {
  /* When */
  const next = stepTarget([], null, 1);

  /* Then */
  assert.equal(next, null);
});

test('after a removal the cursor goes down', () => {
  /* When */
  const target = targetAfterRemoval(['a', 'b', 'c'], 'b', ['a', 'c']);

  /* Then */
  assert.equal(target, 'c');
});

test('after removing the last target the cursor goes up', () => {
  /* When */
  const target = targetAfterRemoval(['a', 'b', 'c'], 'c', ['a', 'b']);

  /* Then */
  assert.equal(target, 'b');
});

test('a removed group takes its rows with it: the cursor goes to the next survivor below', () => {
  /* When */
  const target = targetAfterRemoval(['a', 'g', 'g1', 'g2', 'd'], 'g', ['a', 'd']);

  /* Then */
  assert.equal(target, 'd');
});

test('after removing the only target the cursor goes nowhere', () => {
  /* When */
  const target = targetAfterRemoval(['a'], 'a', []);

  /* Then */
  assert.equal(target, null);
});

test('headers are named after their group', () => {
  /* When */
  const name = headerTarget('slug-x');

  /* Then */
  assert.equal(name, 'header:slug-x');
});
