import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutSessionList, listItems, layoutRows, orderEntries, planPinId, rowId, slugId, truncateEntries,
} from '../src/renderer/state/session-list-layout';
import {
  TIER_ATTENTION, TIER_PINNED, TIER_PINNED_PLAN, TIER_READY, TIER_REST, TIER_RUNNING, sessionTier,
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
    filters: {
      showArchived: false, showStarredOnly: false, showRunningOnly: false, showSnoozedOnly: false, showTodayOnly: false,
      searchMatchIds: null,
    },
    running: new Set(),
    activeSessionId: null,
    tierOf: () => TIER_REST,
    keyOf: (id) => 'k-' + id,
    today: localDateKey(new Date(NOW)),
    now: NOW,
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
  /* Given */
  const projects = [
    project('/one', [session('a', { slug: 'plan' }), session('b', { slug: 'plan', modified: at(10) })]),
    project('/two', [session('c', { slug: 'plan', projectPath: '/two' }), session('d', { slug: 'plan', projectPath: '/two' })]),
    project('/three', [session('e', { slug: 'solo' })]),
  ];

  /* When */
  const { items } = listItems(projects, inputs());

  /* Then */
  assert.deepEqual(items.map(i => i.entry.id), [slugId('plan', '/one'), slugId('plan', '/two'), r('e')]);
  const group = items[0].entry;
  assert.equal(group.kind, 'group');
  // Newest first inside the group.
  assert.deepEqual(group.kind === 'group' && group.sessions.map(s => s.session.sessionId), ['b', 'a']);
});

test('a group takes the newest time, any pin, the highest tier and any remote of its sessions', () => {
  /* Given */
  const projects = [project('/one', [
    session('a', { slug: 'plan', modified: at(5 * HOUR), starred: 1 }),
    session('b', { slug: 'plan', modified: at(HOUR), type: 'remote' }),
  ])];

  /* When */
  const { items } = listItems(projects, inputs({ tierOf: id => (id === 'a' ? TIER_RUNNING : TIER_REST) }));

  /* Then */
  assert.deepEqual(
    { sortTime: items[0].sortTime, pinned: items[0].pinned, tier: items[0].tier, remote: items[0].remote },
    { sortTime: NOW - HOUR, pinned: true, tier: TIER_RUNNING, remote: true });
});

test('a group is started when its newest-started session was', () => {
  /* Given */
  const projects = [project('/p', [
    session('a', { slug: 'plan', created: at(DAY), modified: at(HOUR) }),
    session('b', { slug: 'plan', created: at(2 * HOUR), modified: at(5 * HOUR) }),
  ])];

  /* When */
  const { items } = listItems(projects, inputs());

  /* Then */
  assert.equal(items[0].startTime, NOW - 2 * HOUR);
});

const activeProjects = () => [project('/one', [session('a', { slug: 'plan' }), session('b', { slug: 'plan' }), session('c')])];

test('the active item is the row', () => {
  /* When */
  const { activeItemId } = listItems(activeProjects(), inputs({ activeSessionId: 'c' }));

  /* Then */
  assert.equal(activeItemId, r('c'));
});

test('the active item is the group holding the active row', () => {
  /* When */
  const { activeItemId } = listItems(activeProjects(), inputs({ activeSessionId: 'a' }));

  /* Then */
  assert.equal(activeItemId, slugId('plan', '/one'));
});

test('there is no active item when the active session is not listed', () => {
  /* When */
  const { activeItemId } = listItems(activeProjects(), inputs({ activeSessionId: 'zzz' }));

  /* Then */
  assert.equal(activeItemId, null);
});

test('the filters: archived shows only archived, the others narrow', () => {
  /* Given */
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
  const cases: Array<[Partial<BuildInputs['filters']>, string[]]> = [
    [{}, [r('archived'), r('pinned'), r('running'), r('old')]],
    [{ showArchived: true }, [r('archived')]],
    [{ showStarredOnly: true }, [r('pinned')]],
    [{ showRunningOnly: true }, [r('running')]],
    [{ showTodayOnly: true }, [r('archived'), r('pinned'), r('running')]],
  ];

  for (const [filters, expected] of cases) {
    /* When */
    const visible = visibleWith(filters);

    /* Then */
    assert.deepEqual(visible, expected, JSON.stringify(filters));
  }
});

test('a snoozed session is out of the list until its time', () => {
  /* Given */
  const sessions = [session('asleep', { snoozedUntil: at(-HOUR) }), session('woken', { snoozedUntil: at(HOUR) })];

  /* When */
  const { items } = listItems([project('/p', sessions)], inputs());

  /* Then */
  assert.deepEqual(items.map(i => i.entry.id), [r('woken')]);
});

test('the snoozed filter lists only the sessions still asleep', () => {
  /* Given */
  const sessions = [
    session('asleep', { snoozedUntil: at(-HOUR) }),
    session('woken', { snoozedUntil: at(HOUR) }),
    session('awake'),
  ];

  /* When */
  const { items } = listItems([project('/p', sessions)], inputs({
    filters: { ...inputs().filters, showSnoozedOnly: true },
  }));

  /* Then */
  assert.deepEqual(items.map(i => i.entry.id), [r('asleep')]);
});

test('a search finds a snoozed session, so it can be woken early', () => {
  /* Given */
  const sessions = [session('asleep', { snoozedUntil: at(-HOUR) })];

  /* When */
  const { items } = listItems([project('/p', sessions)], inputs({
    filters: { ...inputs().filters, searchMatchIds: new Set(['asleep']) },
  }));

  /* Then */
  assert.deepEqual(items.map(i => i.entry.id), [r('asleep')]);
});

test('a row is a copy: changing the shared session afterwards does not change the layout', () => {
  /* Given */
  const shared = session('a');
  const { items } = listItems([project('/p', [shared])], inputs());

  /* When */
  shared.name = 'Renamed later';

  /* Then */
  assert.equal(items[0].entry.kind === 'row' && items[0].entry.session.name, null);
});

test('rows are keyed by the local key, not the session id', () => {
  /* When */
  const { items } = listItems([project('/p', [session('a')])], inputs({ keyOf: () => 'key-7' }));

  /* Then */
  assert.equal(items[0].entry.id, 'si-key-7');
});

// ── Ordering ──

test('needs input, ready, working, pinned, then the rest, newest first within each', () => {
  /* Given */
  const tiers: Record<string, number> = { attention: TIER_ATTENTION, ready: TIER_READY, working: TIER_RUNNING };
  const projects = [project('/p', [
    session('rest-old', { modified: at(5 * HOUR) }),
    session('rest-new', { modified: at(HOUR) }),
    session('pinned', { starred: 1, modified: at(DAY) }),
    session('working'),
    session('ready'),
    session('attention'),
  ])];

  /* When */
  const { layout: laid } = layout(projects, { tierOf: id => tiers[id] ?? TIER_REST });

  /* Then */
  assert.deepEqual(ids(laid.visible), [r('attention'), r('ready'), r('working'), r('pinned'), r('rest-new'), r('rest-old')]);
  assert.deepEqual(laid.visible.map(l => l.tier),
    [TIER_ATTENTION, TIER_READY, TIER_RUNNING, TIER_PINNED, TIER_REST, TIER_REST]);
});

test('working sessions keep their order while their transcripts are written to', () => {
  /* Given */
  const working = (modified: Record<string, number>) => [project('/p', [
    session('first', { created: at(3 * HOUR), modified: at(modified.first) }),
    session('second', { created: at(2 * HOUR), modified: at(modified.second) }),
    session('third', { created: at(HOUR), modified: at(modified.third) }),
  ])];
  const before = layout(working({ first: 30, second: 20, third: 10 }), { tierOf: () => TIER_RUNNING });

  /* When */
  const after = layout(working({ first: 1, second: 3, third: 2 }), { tierOf: () => TIER_RUNNING }, {
    previous: before.order,
  });

  /* Then */
  assert.deepEqual(ids(before.layout.visible), [r('third'), r('second'), r('first')]);
  assert.deepEqual(ids(after.layout.visible), ids(before.layout.visible));
});

test('a newly started session lands on top of Working', () => {
  /* Given */
  const sessions = [
    session('older', { created: at(2 * HOUR), modified: at(0) }),
    session('old', { created: at(HOUR), modified: at(0) }),
  ];
  const before = layout([project('/p', sessions)], { tierOf: () => TIER_RUNNING });

  /* When */
  const after = layout([project('/p', [...sessions, session('new', { created: at(10), modified: at(10) })])],
    { tierOf: () => TIER_RUNNING }, { previous: before.order });

  /* Then */
  assert.deepEqual(ids(after.layout.visible), [r('new'), r('old'), r('older')]);
});

test('a re-sort keeps Working in start order', () => {
  /* Given */
  const next = items([['a', 0, TIER_RUNNING, 2 * HOUR], ['b', HOUR, TIER_RUNNING, HOUR]]);

  /* When */
  const laid = orderEntries(next, null, true, []);

  /* Then */
  assert.deepEqual(laid.map(l => l.entry.id), ['b', 'a']);
});

test('a live pinned session files under its live section, not under Pinned', () => {
  /* Given */
  const projects = [project('/p', [session('a', { starred: 1 })])];

  /* When */
  const { layout: laid } = layout(projects, { tierOf: () => TIER_RUNNING });

  /* Then */
  assert.equal(laid.visible[0].tier, TIER_RUNNING);
});

// ── Pinned plans ──

test('a pinned plan sits above every unpinned session, live ones included', () => {
  /* Given */
  const tiers: Record<string, number> = { asking: TIER_ATTENTION, ready: TIER_READY, working: TIER_RUNNING };
  const projects = [
    project('/p', [
      session('asking', { modified: at(0) }),
      session('ready', { modified: at(0) }),
      session('working', { modified: at(0) }),
      session('starred', { starred: 1, modified: at(0) }),
      session('recent', { modified: at(0) }),
      session('p1', { slug: 'plan', modified: at(5 * DAY) }),
      session('p2', { slug: 'plan', modified: at(6 * DAY) }),
    ], { pinnedPlans: ['plan'] }),
  ];

  /* When */
  const { layout: laid } = layout(projects, { tierOf: id => tiers[id] ?? TIER_REST });

  /* Then */
  assert.deepEqual(ids(laid.visible), [slugId('plan', '/p'), r('asking'), r('ready'), r('working'), r('starred'), r('recent')]);
  assert.equal(laid.visible[0].tier, TIER_PINNED_PLAN);
});

test('a pinned plan stays on top while its own sessions ask, finish and work', () => {
  /* Given */
  const projects = [project('/p', [
    session('other', { modified: at(0) }),
    session('p1', { slug: 'plan' }),
    session('p2', { slug: 'plan' }),
  ], { pinnedPlans: ['plan'] })];

  for (const tier of [TIER_ATTENTION, TIER_READY, TIER_RUNNING]) {
    /* When */
    const { layout: laid } = layout(projects, { tierOf: id => (id === 'p1' ? tier : TIER_ATTENTION) });

    /* Then */
    assert.deepEqual(ids(laid.visible), [slugId('plan', '/p'), r('other')]);
  }
});

test('a pinned plan with one session left still shows as its plan', () => {
  /* Given */
  const projects = [project('/p', [session('p1', { slug: 'plan' })], { pinnedPlans: ['plan'] })];

  /* When */
  const { layout: laid } = layout(projects);

  /* Then */
  assert.equal(laid.visible[0].entry.kind, 'group');
  assert.equal(laid.visible[0].tier, TIER_PINNED_PLAN);
});

test('pinning a plan pins only that plan in that project', () => {
  /* Given */
  const projects = [
    project('/one', [session('a', { slug: 'plan' }), session('b', { slug: 'plan' })], { pinnedPlans: ['plan'] }),
    project('/two', [
      session('c', { slug: 'plan', projectPath: '/two' }), session('d', { slug: 'plan', projectPath: '/two' }),
    ]),
  ];

  /* When */
  const { layout: laid } = layout(projects);

  /* Then */
  assert.deepEqual(laid.visible.map(l => [l.entry.id, l.tier]),
    [[slugId('plan', '/one'), TIER_PINNED_PLAN], [slugId('plan', '/two'), TIER_REST]]);
});

const issuePlan = (number: number, pinnedAt: number) => ({ repository: 'acme/app', number, title: 'Plan ' + number, pinnedAt });

test('a GitHub plan pinned from its page sits under Pinned plans, as a row that opens it', () => {
  /* Given */
  const projects = [project('/p', [session('asking', { modified: at(0) })], { pinnedIssuePlans: [issuePlan(12, NOW - 30 * DAY)] })];

  /* When */
  const { layout: laid } = layout(projects, { tierOf: () => TIER_ATTENTION });

  /* Then */
  assert.deepEqual(laid.visible.map(l => [l.entry.id, l.tier]),
    [[planPinId('/p', 'acme/app', 12), TIER_PINNED_PLAN], [r('asking'), TIER_ATTENTION]]);
  assert.deepEqual(laid.visible[0].entry, {
    kind: 'plan', id: planPinId('/p', 'acme/app', 12), projectPath: '/p', repository: 'acme/app', number: 12, title: 'Plan 12',
  });
});

test('a pinned GitHub plan shows in a project with no sessions, and holds no rows', () => {
  /* Given */
  const projects = [project('/empty', [], { pinnedIssuePlans: [issuePlan(12, NOW)] })];

  /* When */
  const { layout: laid } = layout(projects);

  /* Then */
  assert.deepEqual(ids(laid.visible), [planPinId('/empty', 'acme/app', 12)]);
  assert.deepEqual(layoutRows(laid), []);
});

test('pinned GitHub plans list the latest pin first', () => {
  /* Given */
  const projects = [project('/p', [], { pinnedIssuePlans: [issuePlan(1, NOW - DAY), issuePlan(2, NOW)] })];

  /* When */
  const { layout: laid } = layout(projects);

  /* Then */
  assert.deepEqual(ids(laid.visible), [planPinId('/p', 'acme/app', 2), planPinId('/p', 'acme/app', 1)]);
});

test('a filter or a search leaves pinned GitHub plans out', () => {
  /* Given */
  const projects = [project('/p', [session('a', { starred: 1 })], { pinnedIssuePlans: [issuePlan(12, NOW)] })];

  /* When */
  const starred = layout(projects, { filters: { ...inputs().filters, showStarredOnly: true } }, { filtering: true });
  const search = layout(projects, { filters: { ...inputs().filters, searchMatchIds: new Set(['a']) } }, { filtering: true });

  /* Then */
  assert.deepEqual(ids(starred.layout.visible), [r('a')]);
  assert.deepEqual(ids(search.layout.visible), [r('a')]);
});

test('a pinned plan never folds away, however old', () => {
  /* When */
  const laid = truncate([{ id: 'fresh', msAgo: HOUR }, { id: 'plan', msAgo: 30 * DAY, pinnedPlan: true }],
    { visibleSessionCount: 1 });

  /* Then */
  assert.deepEqual(laid, { visible: ['fresh', 'plan'], older: [] });
});

function items(spec: [id: string, msAgo: number, tier?: number, startedMsAgo?: number][]): ListItem[] {
  return spec.map(([id, msAgo, tier = TIER_REST, startedMsAgo = msAgo]) => ({
    entry: { kind: 'row', id, session: session(id), projectPath: '/p' },
    sortTime: NOW - msAgo, startTime: NOW - startedMsAgo, pinned: false, pinnedPlan: false, tier, remote: false,
  }));
}

const readyPair = () => ({
  previous: [{ id: 'a', tier: TIER_READY }, { id: 'b', tier: TIER_READY }],
  // b has become the newest; a is open.
  next: items([['a', 2 * HOUR, TIER_READY], ['b', 0, TIER_READY]]),
});

test('the open session keeps its slot while the rest reorders', () => {
  /* Given */
  const { previous, next } = readyPair();

  /* When */
  const laid = orderEntries(next, 'a', false, previous);

  /* Then */
  assert.deepEqual(laid.map(l => l.entry.id), ['a', 'b']);
});

test('without an open session recency wins', () => {
  /* Given */
  const { previous, next } = readyPair();

  /* When */
  const laid = orderEntries(next, null, false, previous);

  /* Then */
  assert.deepEqual(laid.map(l => l.entry.id), ['b', 'a']);
});

test('on a re-sort recency wins', () => {
  /* Given */
  const { previous, next } = readyPair();

  /* When */
  const laid = orderEntries(next, 'a', true, previous);

  /* Then */
  assert.deepEqual(laid.map(l => l.entry.id), ['b', 'a']);
});

test('the anchor holds only within its section: a busy↔idle flip moves the row', () => {
  /* Given */
  const previous = [{ id: 'a', tier: TIER_READY }, { id: 'b', tier: TIER_RUNNING }, { id: 'c', tier: TIER_RUNNING }];
  // a went busy: it is filed under Working, by start time, whatever slot it had.
  const next = items([['a', 3 * HOUR, TIER_RUNNING], ['b', HOUR, TIER_RUNNING], ['c', 2 * HOUR, TIER_RUNNING]]);

  /* When */
  const laid = orderEntries(next, 'a', false, previous);

  /* Then */
  assert.deepEqual(laid.map(l => [l.entry.id, l.tier]), [['b', TIER_RUNNING], ['c', TIER_RUNNING], ['a', TIER_RUNNING]]);
});

test('an anchor past the end of its shrunken section lands last', () => {
  /* Given */
  const previous = [{ id: 'x', tier: TIER_REST }, { id: 'y', tier: TIER_REST }, { id: 'a', tier: TIER_REST }];

  /* When */
  const laid = orderEntries(items([['a', 3 * HOUR], ['b', HOUR]]), 'a', false, previous);

  /* Then */
  assert.deepEqual(laid.map(l => l.entry.id), ['b', 'a']);
});

// ── Truncation (ported from sidebar-truncation) ──

function truncate(spec: (Partial<ListItem> & { id: string; msAgo: number; tier?: number })[], {
  active = null as string | null, visibleSessionCount = 25,
} = {}) {
  const list: ListItem[] = spec.map(({ id, msAgo, tier = TIER_REST, pinned = false, pinnedPlan = false, remote = false }) => ({
    entry: { kind: 'row', id, session: session(id), projectPath: '/p' },
    sortTime: NOW - msAgo, startTime: NOW - msAgo, pinned, pinnedPlan, tier, remote,
  }));
  const ordered = list.map(item => ({ entry: item.entry, tier: item.tier }));
  const { visible, older } = truncateEntries(ordered, new Map(list.map(i => [i.entry.id, i])), active,
    { visibleSessionCount, sessionMaxAgeDays: 3, now: NOW });
  return { visible: ids(visible), older: ids(older) };
}

test('a stale local row is folded away', () => {
  /* When */
  const laid = truncate([{ id: 'fresh', msAgo: HOUR }, { id: 'stale', msAgo: 30 * DAY }]);

  /* Then */
  assert.deepEqual(laid, { visible: ['fresh'], older: ['stale'] });
});

test('a remote row survives however old it looks', () => {
  // The regression this guards: a remote session whose tmux session is still
  // running on the host, but whose `modified` has not moved since the user last
  // opened it, was dropped from the list — indistinguishable from archiving.

  /* When */
  const laid = truncate([{ id: 'fresh', msAgo: HOUR }, { id: 'remote', msAgo: 30 * DAY, remote: true }]);

  /* Then */
  assert.deepEqual(laid, { visible: ['fresh', 'remote'], older: [] });
});

test('a remote row survives past the count', () => {
  /* When */
  const laid = truncate([{ id: 'fresh', msAgo: HOUR }, { id: 'remote', msAgo: 0, remote: true }], { visibleSessionCount: 1 });

  /* Then */
  assert.deepEqual(laid, { visible: ['fresh', 'remote'], older: [] });
});

test('live, pinned and open rows always show', () => {
  /* Given */
  const spec = [
    { id: 'fresh', msAgo: HOUR },
    { id: 'running', msAgo: 30 * DAY, tier: TIER_RUNNING },
    { id: 'pinned', msAgo: 30 * DAY, pinned: true },
    { id: 'open', msAgo: 30 * DAY },
    { id: 'stale', msAgo: 30 * DAY },
  ];

  /* When */
  const laid = truncate(spec, { active: 'open' });

  /* Then */
  assert.deepEqual(laid, { visible: ['fresh', 'running', 'pinned', 'open'], older: ['stale'] });
});

test('a recent row shows while there is budget, and not after', () => {
  /* Given */
  const spec = [{ id: 'one', msAgo: HOUR }, { id: 'two', msAgo: 2 * HOUR }, { id: 'three', msAgo: 3 * HOUR }];

  /* When */
  const laid = truncate(spec, { visibleSessionCount: 2 });

  /* Then */
  assert.deepEqual(laid, { visible: ['one', 'two'], older: ['three'] });
});

test('every row shows when all of them would fold away', () => {
  /* When */
  const laid = truncate([{ id: 'old', msAgo: 8 * DAY }, { id: 'older', msAgo: 9 * DAY }]);

  /* Then */
  assert.deepEqual(laid, { visible: ['old', 'older'], older: [] });
});

const freshAndStale = () => [project('/p', [session('fresh'), session('stale', { modified: at(30 * DAY) })])];

test('nothing folds while filtering', () => {
  /* When */
  const laid = layout(freshAndStale(), {}, { filtering: true });

  /* Then */
  assert.deepEqual(ids(laid.layout.visible), [r('fresh'), r('stale')]);
});

test('the order covers the folded rows', () => {
  /* When */
  const unfiltered = layout(freshAndStale());

  /* Then */
  assert.deepEqual(ids(unfiltered.layout.older), [r('stale')]);
  assert.deepEqual(unfiltered.order.map(e => e.id), [r('fresh'), r('stale')]);
});

// ── Pending rows (ported from pending-sessions) ──

function signals(overrides: Partial<SessionSignals> = {}): SessionSignals {
  return { needsAttention: false, responseReady: false, busy: false, pending: false, hasLivePty: false, ...overrides };
}

test('a pending row with a live PTY is Working, and never folds away', () => {
  /* Given */
  const pending = session('pending', { modified: at(30 * DAY) });
  const projects = [project('/p', [session('fresh'), pending])];

  /* When */
  const { layout: laid } = layout(projects, {
    tierOf: id => (id === 'pending' ? sessionTier(signals({ pending: true, hasLivePty: true })) : TIER_REST),
  });

  /* Then */
  assert.deepEqual(laid.visible.map(l => [l.entry.id, l.tier]), [[r('pending'), TIER_RUNNING], [r('fresh'), TIER_REST]]);
});

test('a pending row with no PTY is not Working, so it can age out of the list', () => {
  // Working is exempt from truncation, so filing a dead placeholder there is
  // what made it impossible to age out of the list.

  /* Given */
  const pending = session('pending', { modified: at(30 * DAY) });
  const projects = [project('/p', [session('fresh'), pending])];

  /* When */
  const { layout: laid } = layout(projects, {
    tierOf: id => (id === 'pending' ? sessionTier(signals({ pending: true })) : TIER_REST),
  });

  /* Then */
  assert.deepEqual(ids(laid.older), [r('pending')]);
});
