/**
 * The Bug manager page, renderer side (#414): the tabs and their counts, the
 * tiles that filter the inbox, the groups by local project with "Not linked"
 * last, the cursor's walk, and what each key does to the row under it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    bugGroups,
    bugPageReducer,
    bugRows,
    bugTiles,
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

test("the tiles count the inbox's unread, trending, regressed and new bugs, and those in progress", () => {
    /* Given */
    const items = [
        item('a', {signals: {trending: true}}),
        item('b', {state: {kind: 'read'}, signals: {new: true}}),
        item('c', {signals: {regressed: true, trending: true}}),
        item('d', {state: {kind: 'inProgress', stage: 'prCi'}, signals: {trending: true}}),
    ];

    /* Then */
    assert.deepEqual(bugTiles(items), {unread: 2, trending: 2, regressed: 1, new: 1, inProgress: 1});
});

test('a tile filters the inbox, and the same tile again shows all of it', () => {
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

test('a tile chosen from another tab goes back to the inbox, filtered', () => {
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
