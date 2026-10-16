import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutSessionList, listItems, orderEntries, rowId, slugId, truncateEntries,
} from '../src/renderer/state/session-list-layout';
import {
  TIER_ATTENTION, TIER_PINNED, TIER_READY, TIER_REST, TIER_RUNNING, sessionTier,
} from '../src/domain/session/tiers';
import { localDateKey } from '../src/renderer/lib/format';
import type { BuildInputs, ListItem, OrderedEntry } from '../src/renderer/state/session-list-layout';
import type { Project } from '../src/domain/project/project';
import type { SessionRow } from '../src/domain/session/session';
import type { SessionSignals } from '../src/domain/session/tiers';

const NOW = 1_700_000_000_000;
const DAY = 86400000;
const HOUR = 3600000;

function session(id: string, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: id,
    summary: 'Session ' + id,
    firstPrompt: '',
    projectPath: '/repo',
    created: new Date(NOW - DAY).toISOString(),
    modified: new Date(NOW - HOUR).toISOString(),
    messageCount: 1,
    name: null,
    starred: 0,
    archived: 0,
    ...extra,
  };
}

const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function project(projectPath: string, sessions: SessionRow[], extra: Partial<Project> = {}): Project {
  return { projectPath, folder: projectPath.replace(/\//g, '-'), sessions, ...extra };
}

function inputs(extra: Partial<BuildInputs> = {}): BuildInputs {
  return {
    filters: { showArchived: false, showStarredOnly: false, showRunningOnly: false, showTodayOnly: false },
    running: new Set(),
    activeSessionId: null,
    tierOf: () => TIER_REST,
    keyOf: (id) => 'k-' + id,
    today: localDateKey(new Date(NOW)),
    ...extra,
  };
}

/** Lay out the projects the way one redraw does, and answer the visible ids top to bottom. */
function layout(
  projects: Project[],
  extra: Partial<BuildInputs> = {},
  { previous = [] as OrderedEntry[], resort = false, filtering = false, visibleSessionCount = 25, sessionMaxAgeDays = 3 } = {},
) {
  const built = listItems(projects, inputs(extra));
  return layoutSessionList(built.items, previous, {
    activeItemId: built.activeItemId, resort, filtering, visibleSessionCount, sessionMaxAgeDays, now: NOW,
  });
}

const ids = (laid: readonly { entry: { id: string } }[]): string[] => laid.map(l => l.entry.id);
const r = (id: string): string => rowId('k-' + id);

// ── Building ──

test('sessions sharing a slug fold into one group per project', () => {
  const { items } = listItems([
    project('/one', [session('a', { slug: 'plan' }), session('b', { slug: 'plan', modified: at(10) })]),
    project('/two', [session('c', { slug: 'plan', projectPath: '/two' }), session('d', { slug: 'plan', projectPath: '/two' })]),
    project('/three', [session('e', { slug: 'solo' })]),
  ], inputs());

  assert.deepEqual(items.map(i => i.entry.id), [slugId('plan', '/one'), slugId('plan', '/two'), r('e')]);
  const group = items[0].entry;
  assert.equal(group.kind, 'group');
  // Newest first inside the group.
  assert.deepEqual(group.kind === 'group' && group.sessions.map(s => s.session.sessionId), ['b', 'a']);
});

test('a group takes the newest time, any pin, the highest tier and any remote of its sessions', () => {
  const { items } = listItems([project('/one', [
    session('a', { slug: 'plan', modified: at(5 * HOUR), starred: 1 }),
    session('b', { slug: 'plan', modified: at(HOUR), type: 'remote' }),
  ])], inputs({ tierOf: id => (id === 'a' ? TIER_RUNNING : TIER_REST) }));
  assert.deepEqual(
    { sortTime: items[0].sortTime, pinned: items[0].pinned, tier: items[0].tier, remote: items[0].remote },
    { sortTime: NOW - HOUR, pinned: true, tier: TIER_RUNNING, remote: true });
});

test('the active item is the row, or the group holding it', () => {
  const projects = [project('/one', [session('a', { slug: 'plan' }), session('b', { slug: 'plan' }), session('c')])];
  assert.equal(listItems(projects, inputs({ activeSessionId: 'c' })).activeItemId, r('c'));
  assert.equal(listItems(projects, inputs({ activeSessionId: 'a' })).activeItemId, slugId('plan', '/one'));
  assert.equal(listItems(projects, inputs({ activeSessionId: 'zzz' })).activeItemId, null);
});

test('the filters: archived shows only archived, the others narrow', () => {
  const sessions = [
    session('archived', { archived: 1, modified: at(0) }),
    session('pinned', { starred: 1, modified: at(0) }),
    session('running', { modified: at(0) }),
    session('old', { modified: at(2 * DAY) }),
  ];
  const visibleWith = (filters: Partial<BuildInputs['filters']>) => listItems([project('/p', sessions)], inputs({
    filters: { ...inputs().filters, ...filters },
    running: new Set(['running']),
  })).items.map(i => i.entry.id);

  assert.deepEqual(visibleWith({}), [r('archived'), r('pinned'), r('running'), r('old')]);
  assert.deepEqual(visibleWith({ showArchived: true }), [r('archived')]);
  assert.deepEqual(visibleWith({ showStarredOnly: true }), [r('pinned')]);
  assert.deepEqual(visibleWith({ showRunningOnly: true }), [r('running')]);
  assert.deepEqual(visibleWith({ showTodayOnly: true }), [r('archived'), r('pinned'), r('running')]);
});

test('a row is a copy: changing the shared session afterwards does not change the layout', () => {
  const shared = session('a');
  const { items } = listItems([project('/p', [shared])], inputs());
  shared.name = 'Renamed later';
  assert.equal(items[0].entry.kind === 'row' && items[0].entry.session.name, null);
});

test('rows are keyed by the local key, not the session id', () => {
  const { items } = listItems([project('/p', [session('a')])], inputs({ keyOf: () => 'key-7' }));
  assert.equal(items[0].entry.id, 'si-key-7');
});

// ── Ordering ──

test('needs input, ready, working, pinned, then the rest, newest first within each', () => {
  const tiers: Record<string, number> = { attention: TIER_ATTENTION, ready: TIER_READY, working: TIER_RUNNING };
  const { layout: laid } = layout([project('/p', [
    session('rest-old', { modified: at(5 * HOUR) }),
    session('rest-new', { modified: at(HOUR) }),
    session('pinned', { starred: 1, modified: at(DAY) }),
    session('working'),
    session('ready'),
    session('attention'),
  ])], { tierOf: id => tiers[id] ?? TIER_REST });

  assert.deepEqual(ids(laid.visible), [r('attention'), r('ready'), r('working'), r('pinned'), r('rest-new'), r('rest-old')]);
  assert.deepEqual(laid.visible.map(l => l.tier),
    [TIER_ATTENTION, TIER_READY, TIER_RUNNING, TIER_PINNED, TIER_REST, TIER_REST]);
});

test('a live pinned session files under its live section, not under Pinned', () => {
  const { layout: laid } = layout([project('/p', [session('a', { starred: 1 })])], { tierOf: () => TIER_RUNNING });
  assert.equal(laid.visible[0].tier, TIER_RUNNING);
});

function items(spec: [id: string, msAgo: number, tier?: number][]): ListItem[] {
  return spec.map(([id, msAgo, tier = TIER_REST]) => ({
    entry: { kind: 'row', id, session: session(id), projectPath: '/p' },
    sortTime: NOW - msAgo, pinned: false, tier, remote: false,
  }));
}

test('the open session keeps its slot while the rest reorders', () => {
  const previous = [{ id: 'a', tier: TIER_READY }, { id: 'b', tier: TIER_READY }];
  // b has become the newest; a is open.
  const next = items([['a', 2 * HOUR, TIER_READY], ['b', 0, TIER_READY]]);
  assert.deepEqual(orderEntries(next, 'a', false, previous).map(l => l.entry.id), ['a', 'b']);
  // Without an open session, or on a re-sort, recency wins.
  assert.deepEqual(orderEntries(next, null, false, previous).map(l => l.entry.id), ['b', 'a']);
  assert.deepEqual(orderEntries(next, 'a', true, previous).map(l => l.entry.id), ['b', 'a']);
});

test('the anchor holds only within its section: a busy↔idle flip moves the row', () => {
  const previous = [{ id: 'a', tier: TIER_READY }, { id: 'b', tier: TIER_RUNNING }, { id: 'c', tier: TIER_RUNNING }];
  // a went busy: it is filed under Working, by recency, whatever slot it had.
  const next = items([['a', 3 * HOUR, TIER_RUNNING], ['b', HOUR, TIER_RUNNING], ['c', 2 * HOUR, TIER_RUNNING]]);
  const laid = orderEntries(next, 'a', false, previous);
  assert.deepEqual(laid.map(l => [l.entry.id, l.tier]), [['b', TIER_RUNNING], ['c', TIER_RUNNING], ['a', TIER_RUNNING]]);
});

test('an anchor past the end of its shrunken section lands last', () => {
  const previous = [{ id: 'x', tier: TIER_REST }, { id: 'y', tier: TIER_REST }, { id: 'a', tier: TIER_REST }];
  const laid = orderEntries(items([['a', 3 * HOUR], ['b', HOUR]]), 'a', false, previous);
  assert.deepEqual(laid.map(l => l.entry.id), ['b', 'a']);
});

// ── Truncation (ported from sidebar-truncation) ──

function truncate(spec: (Partial<ListItem> & { id: string; msAgo: number; tier?: number })[], {
  active = null as string | null, visibleSessionCount = 25,
} = {}) {
  const list: ListItem[] = spec.map(({ id, msAgo, tier = TIER_REST, pinned = false, remote = false }) => ({
    entry: { kind: 'row', id, session: session(id), projectPath: '/p' },
    sortTime: NOW - msAgo, pinned, tier, remote,
  }));
  const ordered = list.map(item => ({ entry: item.entry, tier: item.tier }));
  const { visible, older } = truncateEntries(ordered, new Map(list.map(i => [i.entry.id, i])), active,
    { visibleSessionCount, sessionMaxAgeDays: 3, now: NOW });
  return { visible: ids(visible), older: ids(older) };
}

test('a stale local row is folded away', () => {
  assert.deepEqual(truncate([{ id: 'fresh', msAgo: HOUR }, { id: 'stale', msAgo: 30 * DAY }]),
    { visible: ['fresh'], older: ['stale'] });
});

test('a remote row survives however old it looks, and past the count', () => {
  // The regression this guards: a remote session whose tmux session is still
  // running on the host, but whose `modified` has not moved since the user last
  // opened it, was dropped from the list — indistinguishable from archiving.
  assert.deepEqual(truncate([{ id: 'fresh', msAgo: HOUR }, { id: 'remote', msAgo: 30 * DAY, remote: true }]),
    { visible: ['fresh', 'remote'], older: [] });
  assert.deepEqual(truncate([{ id: 'fresh', msAgo: HOUR }, { id: 'remote', msAgo: 0, remote: true }],
    { visibleSessionCount: 1 }), { visible: ['fresh', 'remote'], older: [] });
});

test('live, pinned and open rows always show', () => {
  assert.deepEqual(truncate([
    { id: 'fresh', msAgo: HOUR },
    { id: 'running', msAgo: 30 * DAY, tier: TIER_RUNNING },
    { id: 'pinned', msAgo: 30 * DAY, pinned: true },
    { id: 'open', msAgo: 30 * DAY },
    { id: 'stale', msAgo: 30 * DAY },
  ], { active: 'open' }), { visible: ['fresh', 'running', 'pinned', 'open'], older: ['stale'] });
});

test('a recent row shows while there is budget, and not after', () => {
  assert.deepEqual(truncate([
    { id: 'one', msAgo: HOUR }, { id: 'two', msAgo: 2 * HOUR }, { id: 'three', msAgo: 3 * HOUR },
  ], { visibleSessionCount: 2 }), { visible: ['one', 'two'], older: ['three'] });
});

test('every row shows when all of them would fold away', () => {
  assert.deepEqual(truncate([{ id: 'old', msAgo: 8 * DAY }, { id: 'older', msAgo: 9 * DAY }]),
    { visible: ['old', 'older'], older: [] });
});

test('nothing folds while filtering, and the order covers the folded rows', () => {
  const projects = [project('/p', [session('fresh'), session('stale', { modified: at(30 * DAY) })])];
  assert.deepEqual(ids(layout(projects, {}, { filtering: true }).layout.visible), [r('fresh'), r('stale')]);
  const unfiltered = layout(projects);
  assert.deepEqual(ids(unfiltered.layout.older), [r('stale')]);
  assert.deepEqual(unfiltered.order.map(e => e.id), [r('fresh'), r('stale')]);
});

// ── Pending rows (ported from pending-sessions) ──

function signals(overrides: Partial<SessionSignals> = {}): SessionSignals {
  return { needsAttention: false, responseReady: false, busy: false, pending: false, hasLivePty: false, ...overrides };
}

test('a pending row with a live PTY is Working, and never folds away', () => {
  const pending = session('pending', { modified: at(30 * DAY) });
  const { layout: laid } = layout([project('/p', [session('fresh'), pending])], {
    tierOf: id => (id === 'pending' ? sessionTier(signals({ pending: true, hasLivePty: true })) : TIER_REST),
  });
  assert.deepEqual(laid.visible.map(l => [l.entry.id, l.tier]), [[r('pending'), TIER_RUNNING], [r('fresh'), TIER_REST]]);
});

test('a pending row with no PTY is not Working, so it can age out of the list', () => {
  // Working is exempt from truncation, so filing a dead placeholder there is
  // what made it impossible to age out of the list.
  const pending = session('pending', { modified: at(30 * DAY) });
  const { layout: laid } = layout([project('/p', [session('fresh'), pending])], {
    tierOf: id => (id === 'pending' ? sessionTier(signals({ pending: true })) : TIER_REST),
  });
  assert.deepEqual(ids(laid.older), [r('pending')]);
});
