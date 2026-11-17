/**
 * The Bug manager page, renderer side (#414): the tabs and their counts, the
 * filters over the inbox, the groups by local project with "Not linked"
 * last, the cursor's walk, and what each key does to the row under it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    bugGroups,
    bugPageReducer,
    bugRows,
    inProgressWantsYou,
    initialBugPageState,
    steppedBugCursor,
    type BugPageState,
} from '../src/renderer/state/bug-page-slice';
import {tabCounts} from '../src/domain/inbox/tabs';
import {bugKeyAction} from '../src/renderer/ui/bug-manager/page-keys';
import {syncSource} from '../src/domain/inbox/items';
import type {BugsnagProjectSetting} from '../src/domain/bugsnag/connection';
import type {BugFacts, BugSignals, InboxItem, InboxState} from '../src/domain/inbox/model';
import {DAY, NOW, THRESHOLDS, bug} from './support/inbox-fixtures';

const API = 'p-api';
const WEB = 'p-web';
const ANDROID = 'p-android';

const PROJECTS: BugsnagProjectSetting[] = [
    {id: API, name: 'Connect API', optedIn: true, localProject: '/code/connect'},
    {id: WEB, name: 'Connect Web', optedIn: true, localProject: '/code/connect'},
    {id: ANDROID, name: 'Coach Android', optedIn: true, localProject: null},
];

function item(
    errorId: string,
    {
        project = API,
        state = {kind: 'unread'},
        signals = {},
        facts = {},
    }: {project?: string; state?: InboxState; signals?: Partial<BugSignals>; facts?: Partial<BugFacts>} = {},
): InboxItem {
    const arrived = syncSource([], [bug(errorId, {projectId: project, ...facts})], {
        now: NOW,
        complete: true,
        watchingSince: NOW - 30 * DAY,
        thresholds: THRESHOLDS,
        viewer: null,
    }).items[0]!;
    return {...arrived, state, signals: {new: false, trending: false, regressed: false, ...signals}};
}

function page(items: InboxItem[], overrides: Partial<BugPageState> = {}): BugPageState {
    return {...initialBugPageState, items, projects: PROJECTS, loaded: true, ...overrides};
}

test('each tab counts its items: inbox holds unread and read', () => {
    /* Given */
    const items = [
        item('a'),
        item('b', {state: {kind: 'read'}}),
        item('c', {state: {kind: 'inProgress', stage: 'working'}}),
        item('d', {state: {kind: 'done', at: NOW}}),
        item('e', {state: {kind: 'snoozed', until: null}}),
        item('f', {state: {kind: 'backlog'}}),
    ];

    /* Then */
    assert.deepEqual(tabCounts(items), {inbox: 2, inProgress: 1, done: 1, snoozed: 1, backlog: 1});
});

test('a filter narrows the inbox, and the same filter again shows all of it', () => {
    /* Given */
    const state = page([item('a', {signals: {trending: true}}), item('b')]);

    /* When */
    const filtered = bugPageReducer(state, {type: 'bugFilterChosen', filter: 'trending'});
    const again = bugPageReducer(filtered, {type: 'bugFilterChosen', filter: 'trending'});

    /* Then */
    assert.deepEqual(
        bugRows(filtered).map((row) => (row.facts as BugFacts).errorId),
        ['a'],
    );
    assert.equal(bugRows(again).length, 2);
});

test('a filter chosen from another tab goes back to the inbox, filtered', () => {
    /* Given */
    const state = page([item('a', {signals: {new: true}})], {tab: 'done'});

    /* When */
    const next = bugPageReducer(state, {type: 'bugFilterChosen', filter: 'new'});

    /* Then */
    assert.equal(next.tab, 'inbox');
    assert.equal(next.filter, 'new');
});

test('rows group by local project, naming the Bugsnag projects they come from, Not linked last', () => {
    /* Given */
    const state = page([item('a', {project: ANDROID}), item('b', {project: WEB}), item('c', {project: API})]);

    /* When */
    const groups = bugGroups(state);

    /* Then */
    assert.deepEqual(
        groups.map((group) => [group.title, group.sources]),
        [
            ['connect', ['Connect API', 'Connect Web']],
            ['Not linked', ['Coach Android']],
        ],
    );
});

test('within a group unread rows come first, then urgent, then the most recently seen', () => {
    /* Given */
    const hour = (h: number): Partial<BugFacts> => ({lastSeen: new Date(NOW - h * 3600_000).toISOString()});
    const state = page([
        item('read-recent', {state: {kind: 'read'}, facts: hour(1)}),
        item('unread-old', {facts: hour(9)}),
        item('unread-trending', {signals: {trending: true}, facts: hour(20)}),
        item('unread-recent', {facts: hour(2)}),
    ]);

    /* Then */
    assert.deepEqual(
        bugRows(state).map((row) => (row.facts as BugFacts).errorId),
        ['unread-trending', 'unread-recent', 'unread-old', 'read-recent'],
    );
});

test('the cursor steps through the rows and holds at both ends', () => {
    /* Given */
    const state = page([
        item('a', {facts: {lastSeen: '2026-11-13T11:00:00Z'}}),
        item('b', {facts: {lastSeen: '2026-11-13T10:00:00Z'}}),
    ]);

    /* When */
    const down = steppedBugCursor(state, 1);
    const up = steppedBugCursor(state, -1);
    const pastEnd = steppedBugCursor({...state, cursor: down}, 1);

    /* Then */
    assert.equal(down, `bug:${API}:b`);
    assert.equal(up, `bug:${API}:a`);
    assert.equal(pastEnd, `bug:${API}:b`);
});

/** J as the page does it: move the cursor, then mark the row it lands on seen. */
function pressJ(state: BugPageState): BugPageState {
    const key = steppedBugCursor(state, 1);
    const moved = bugPageReducer(state, {type: 'bugCursorMoved', key});
    const landed = moved.items.find((row) => row.key === key)!;
    return landed.state.kind === 'unread'
        ? bugPageReducer(moved, {type: 'bugItemChanged', item: {...landed, state: {kind: 'read'}}})
        : moved;
}

test('J walks unread rows one by one while it marks them seen', () => {
    /* Given */
    let state = page([
        item('a', {facts: {lastSeen: '2026-11-13T11:00:00Z'}}),
        item('b', {facts: {lastSeen: '2026-11-13T10:00:00Z'}}),
        item('c', {facts: {lastSeen: '2026-11-13T09:00:00Z'}}),
        item('d', {facts: {lastSeen: '2026-11-13T08:00:00Z'}}),
    ]);

    /* When */
    const visited: (string | null)[] = [];
    for (let press = 0; press < 3; press++) {
        state = pressJ(state);
        visited.push(state.cursor);
    }

    /* Then */
    assert.deepEqual(visited, [`bug:${API}:b`, `bug:${API}:c`, `bug:${API}:d`]);
    assert.deepEqual(
        bugRows(state).map((row) => row.key),
        ['a', 'b', 'c', 'd'].map((id) => `bug:${API}:${id}`),
    );
});

test('a row seen on this visit stays under the Unread filter until the filter changes', () => {
    /* Given */
    const state = page(
        [
            item('a', {facts: {lastSeen: '2026-11-13T11:00:00Z'}}),
            item('b', {facts: {lastSeen: '2026-11-13T10:00:00Z'}}),
        ],
        {filter: 'unread'},
    );

    /* When */
    const seen = pressJ(state);
    const refiltered = bugPageReducer(bugPageReducer(seen, {type: 'bugFilterChosen', filter: 'unread'}), {
        type: 'bugFilterChosen',
        filter: 'unread',
    });

    /* Then */
    assert.equal(bugRows(seen).length, 2);
    assert.deepEqual(
        bugRows(refiltered).map((row) => row.key),
        [`bug:${API}:a`],
    );
});

test('only Needs you and CI failing put the dot on In progress', () => {
    /* Then */
    assert.equal(inProgressWantsYou([item('a', {state: {kind: 'inProgress', stage: 'prCi'}})]), false);
    assert.equal(inProgressWantsYou([item('a', {state: {kind: 'inProgress', stage: 'ciFailing'}})]), true);
    assert.equal(inProgressWantsYou([item('a', {state: {kind: 'inProgress', stage: 'needsYou'}})]), true);
});

test('a changed item replaces the one with its key', () => {
    /* Given */
    const state = page([item('a')]);

    /* When */
    const next = bugPageReducer(state, {type: 'bugItemChanged', item: item('a', {state: {kind: 'backlog'}})});

    /* Then */
    assert.deepEqual(
        next.items.map((row) => row.state.kind),
        ['backlog'],
    );
});

// ── Keys ──

test('J and K move the cursor; F fixes, S snoozes, B backlogs and O opens an inbox bug', () => {
    /* Given */
    const row = item('a');

    /* Then */
    assert.deepEqual(bugKeyAction('j', row), {kind: 'cursor', step: 1});
    assert.deepEqual(bugKeyAction('k', row), {kind: 'cursor', step: -1});
    assert.deepEqual(bugKeyAction('f', row), {kind: 'fix', key: row.key});
    assert.deepEqual(bugKeyAction('s', row), {kind: 'snooze', key: row.key});
    assert.deepEqual(bugKeyAction('b', row), {kind: 'backlog', key: row.key});
    assert.deepEqual(bugKeyAction('o', row), {kind: 'bugsnag', key: row.key});
});

test('on a bug in progress F and Enter open its session, and S and B do nothing', () => {
    /* Given */
    const row = item('a', {state: {kind: 'inProgress', stage: 'working'}});

    /* Then */
    assert.deepEqual(bugKeyAction('f', row), {kind: 'openSession', item: row});
    assert.deepEqual(bugKeyAction('Enter', row), {kind: 'openSession', item: row});
    assert.equal(bugKeyAction('s', row), null);
    assert.equal(bugKeyAction('b', row), null);
});

test('without a row only the cursor keys act', () => {
    /* Then */
    assert.equal(bugKeyAction('f', null), null);
    assert.deepEqual(bugKeyAction('ArrowDown', null), {kind: 'cursor', step: 1});
});

test('T triages a bug in the inbox, snoozed, in the backlog or done, not one in progress', () => {
    /* Given */
    const sortable = [
        item('a'),
        item('b', {state: {kind: 'read'}}),
        item('c', {state: {kind: 'snoozed', until: null}}),
        item('d', {state: {kind: 'backlog'}}),
        item('e', {state: {kind: 'done', at: NOW}}),
    ];
    const fixing = item('f', {state: {kind: 'inProgress', stage: 'working'}});

    /* When */
    const actions = sortable.map((row) => bugKeyAction('t', row));
    const inProgress = bugKeyAction('t', fixing);

    /* Then */
    assert.deepEqual(
        actions,
        sortable.map((row) => ({kind: 'triage', key: row.key})),
    );
    assert.equal(inProgress, null);
});

test('T does nothing while a triage runs, and triages again once it stopped or has its verdict', () => {
    /* Given */
    const base = {sessionId: 's', currentId: 's', worktree: '/w', startedAt: NOW, verdict: null, stoppedAt: null};
    const running: InboxItem = {...item('a'), triage: base};
    const stopped: InboxItem = {...item('b'), triage: {...base, stoppedAt: NOW + 1}};
    const judged: InboxItem = {
        ...item('c'),
        triage: {
            ...base,
            verdict: {
                happened: 'h',
                why: 'w',
                where: null,
                impact: 'i',
                suggestion: 'snooze',
                summary: 's',
                confidence: 'low',
                at: NOW,
            },
        },
    };

    /* When */
    const actions = [running, stopped, judged].map((row) => bugKeyAction('t', row));

    /* Then */
    assert.deepEqual(actions, [null, {kind: 'triage', key: stopped.key}, {kind: 'triage', key: judged.key}]);
});

test('a triage being started is held until it answers', () => {
    /* Given */
    const state = page([item('a')]);

    /* When */
    const starting = bugPageReducer(state, {type: 'bugTriaging', key: 'bug:p-api:a'});
    const answered = bugPageReducer(starting, {type: 'bugTriaging', key: null});

    /* Then */
    assert.equal(starting.triaging, 'bug:p-api:a');
    assert.equal(answered.triaging, null);
});
