import {test} from 'node:test';
import assert from 'node:assert/strict';
import {errandRowId, layoutRows, layoutSessionList, listItems, rowId} from '../src/renderer/state/session-list-layout';
import {
    cursorTargets,
    opensShelf,
    rowOrder,
    shownTargets,
    startTarget,
    stepCursor,
} from '../src/renderer/state/list-cursor';
import {initialSessionListState, sessionListReducer} from '../src/renderer/state/session-list-slice';
import {TIER_ATTENTION, TIER_REST} from '../src/domain/session/tiers';
import {localDateKey} from '../src/renderer/lib/format';
import type {ErrandEntry} from '../src/domain/session/errand-shelf';
import type {BuildInputs, OrderedEntry, SessionListLayout} from '../src/renderer/state/session-list-layout';
import type {SessionListState} from '../src/renderer/state/session-list-slice';
import type {Project} from '../src/domain/project/project';
import type {SessionRow} from '../src/domain/session/session';

const NOW = 1_700_000_000_000;
const HOUR = 3600000;
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function session(id: string, extra: Partial<SessionRow> = {}): SessionRow {
    return {
        sessionId: id,
        summary: 'Session ' + id,
        firstPrompt: '',
        projectPath: '/p',
        created: at(10 * HOUR),
        modified: at(HOUR),
        messageCount: 1,
        name: null,
        starred: 0,
        archived: 0,
        ...extra,
    };
}

function project(sessions: SessionRow[]): Project {
    return {projectPath: '/p', folder: '-p', sessions};
}

function errand(sessionId: string, needsYou = false): ErrandEntry {
    return {
        sessionId,
        kind: 'fix',
        owner: 'merge-manager',
        repository: 'acme/app',
        number: 7,
        doing: needsYou ? 'stopped' : 'fixing checks',
        needsYou,
        host: null,
    };
}

/** Errands by session id; the rest are the user's own. */
function inputs(errands: ErrandEntry[], extra: Partial<BuildInputs> = {}): BuildInputs {
    const bySession = new Map(errands.map((e) => [e.sessionId, e]));
    return {
        filters: {
            showArchived: false,
            showStarredOnly: false,
            showRunningOnly: false,
            showSnoozedOnly: false,
            showTodayOnly: false,
            searchMatchIds: null,
        },
        running: new Set(),
        activeSessionId: null,
        tierOf: () => TIER_REST,
        keyOf: (id) => 'k-' + id,
        today: localDateKey(new Date(NOW)),
        now: NOW,
        errandOf: (id) => bySession.get(id) ?? null,
        ...extra,
    };
}

function layout(
    sessions: SessionRow[],
    errands: ErrandEntry[],
    extra: Partial<BuildInputs> = {},
    {previous = [] as OrderedEntry[], filtering = false, visibleSessionCount = 25} = {},
) {
    const built = listItems([project(sessions)], inputs(errands, extra));
    return layoutSessionList(built.items, previous, {
        activeItemId: built.activeItemId,
        resort: false,
        filtering,
        errands: built.errands,
        visibleSessionCount,
        sessionMaxAgeDays: 3,
        now: NOW,
    });
}

const ids = (laid: readonly {entry: {id: string}}[]): string[] => laid.map((l) => l.entry.id);
const si = (id: string): string => rowId('k-' + id);
const er = (id: string): string => errandRowId('k-' + id);

// ── Layout ──

test('an errand goes to the shelf, out of the sections', () => {
    /* Given */
    const sessions = [session('a'), session('x')];

    /* When */
    const {layout: laid} = layout(sessions, [errand('x')]);

    /* Then */
    assert.deepEqual(ids(laid.visible), [si('a')]);
    assert.deepEqual(laid.older, []);
    assert.deepEqual(ids(laid.errands), [er('x')]);
    assert.equal(laid.errands[0].errand.sessionId, 'x');
});

test('an errand never joins a slug group', () => {
    /* Given */
    const sessions = [session('a', {slug: 'plan'}), session('x', {slug: 'plan'})];

    /* When */
    const {layout: laid} = layout(sessions, [errand('x')]);

    /* Then */
    assert.deepEqual(ids(laid.visible), [si('a')]);
    assert.equal(laid.visible[0].entry.kind, 'row');
    assert.deepEqual(ids(laid.errands), [er('x')]);
});

test('a stuck errand also asks in Blocked, below the user’s own, however it was anchored', () => {
    /* Given: x sat on top of Blocked last time, and is the session on screen */
    const sessions = [session('a', {modified: at(5 * HOUR)}), session('x', {modified: at(HOUR)})];
    const previous = [
        {id: si('x'), tier: TIER_ATTENTION},
        {id: si('a'), tier: TIER_ATTENTION},
    ];

    /* When */
    const {layout: laid} = layout(
        sessions,
        [errand('x', true)],
        {tierOf: () => TIER_ATTENTION, activeSessionId: 'x'},
        {previous},
    );

    /* Then */
    assert.deepEqual(ids(laid.visible), [si('a'), si('x')]);
    assert.deepEqual(
        laid.visible.map((l) => l.tier),
        [TIER_ATTENTION, TIER_ATTENTION],
    );
    assert.deepEqual(ids(laid.errands), [er('x')]);
});

test('a stuck errand is in Blocked whatever its own signals say', () => {
    /* Given */
    const sessions = [session('x')];

    /* When */
    const {layout: laid} = layout(sessions, [errand('x', true)], {tierOf: () => TIER_REST});

    /* Then */
    assert.deepEqual(
        laid.visible.map((l) => [l.entry.id, l.tier]),
        [[si('x'), TIER_ATTENTION]],
    );
});

test('a stuck errand takes none of the user’s visible slots', () => {
    /* Given: room for one row */
    const sessions = [
        session('a', {modified: at(HOUR)}),
        session('b', {modified: at(2 * HOUR)}),
        session('x', {modified: at(3 * HOUR)}),
    ];

    /* When */
    const {layout: laid} = layout(sessions, [errand('x', true)], {}, {visibleSessionCount: 1});

    /* Then */
    assert.deepEqual(ids(laid.visible), [si('x'), si('a')]);
    assert.deepEqual(ids(laid.older), [si('b')]);
});

test('the shelf puts the ones that need you first, then the newest started', () => {
    /* Given */
    const sessions = [
        session('old', {created: at(9 * HOUR)}),
        session('new', {created: at(1 * HOUR)}),
        session('stuck', {created: at(20 * HOUR)}),
    ];

    /* When */
    const {layout: laid} = layout(sessions, [errand('old'), errand('new'), errand('stuck', true)]);

    /* Then */
    assert.deepEqual(ids(laid.errands), [er('stuck'), er('new'), er('old')]);
});

test('an archived errand is not on the shelf', () => {
    /* Given */
    const sessions = [session('a'), session('x', {archived: 1})];

    /* When */
    const {layout: laid} = layout(sessions, [errand('x', true)]);

    /* Then */
    assert.deepEqual(ids(laid.visible), [si('a')]);
    assert.deepEqual(laid.errands, []);
});

test('while filtering, errands show inline among the matches and the shelf is empty', () => {
    /* Given */
    const sessions = [session('a', {starred: 1}), session('x', {starred: 1})];
    const starred = inputs([]).filters;

    /* When */
    const {layout: laid} = layout(
        sessions,
        [errand('x')],
        {filters: {...starred, showStarredOnly: true}},
        {filtering: true},
    );

    /* Then */
    assert.deepEqual(ids(laid.visible).sort(), [si('a'), si('x')]);
    assert.deepEqual(laid.errands, []);
});

test('the layout’s rows include the shelf’s, a stuck errand under both its ids', () => {
    /* Given */
    const {layout: laid} = layout([session('a'), session('x'), session('y')], [errand('x', true), errand('y')]);

    /* When */
    const rows = layoutRows(laid);

    /* Then */
    assert.deepEqual(rows.map((r) => r.id).sort(), [si('a'), si('x'), er('x'), er('y')].sort());
});

// ── Slice ──

function built(sessions: SessionRow[], errands: ErrandEntry[]) {
    const {items, activeItemId, errands: laid} = listItems([project(sessions)], inputs(errands));
    return {
        type: 'sessionListBuilt' as const,
        items,
        activeItemId,
        errands: laid,
        resort: false,
        filtering: false,
        visibleSessionCount: 25,
        sessionMaxAgeDays: 3,
        now: NOW,
    };
}

test('a redraw lays the shelf out in its order', () => {
    /* Given */
    const event = built(
        [session('x', {created: at(5 * HOUR)}), session('y', {created: at(HOUR)})],
        [errand('x'), errand('y')],
    );

    /* When */
    const state = sessionListReducer(initialSessionListState, event);

    /* Then */
    assert.deepEqual(ids(state.layout!.errands), [er('y'), er('x')]);
});

test('a shelf row mid-exit stays leaving while it is listed, and is forgotten once gone', () => {
    /* Given */
    const first = sessionListReducer(initialSessionListState, built([session('x')], [errand('x')]));
    const leaving = sessionListReducer(first, {type: 'rowLeaving', id: er('x'), leaving: true});

    /* When */
    const still = sessionListReducer(leaving, built([session('x')], [errand('x')]));
    const gone = sessionListReducer(still, built([], []));

    /* Then */
    assert.deepEqual(still.leaving, {[er('x')]: true});
    assert.deepEqual(gone.leaving, {});
});

test('a rename shows on the shelf row too', () => {
    /* Given */
    const state = sessionListReducer(initialSessionListState, built([session('x')], [errand('x', true)]));

    /* When */
    const renamed = sessionListReducer(state, {type: 'sessionRenamed', sessionId: 'x', name: 'Fix it'});

    /* Then */
    assert.equal(renamed.layout!.errands[0].entry.session.name, 'Fix it');
    assert.equal(
        renamed.layout!.visible[0].entry.kind === 'row' && renamed.layout!.visible[0].entry.session.name,
        'Fix it',
    );
});

// ── Cursor ──

/** The user's rows a and b, and the shelf's errands, as one list state. */
function shelf(errands: ErrandEntry[], extra: Partial<SessionListState> = {}): SessionListState {
    const sessions = [
        session('a', {modified: at(HOUR)}),
        session('b', {modified: at(2 * HOUR)}),
        ...errands.map((e, i) => session(e.sessionId, {created: at((i + 1) * HOUR)})),
    ];
    const laid: SessionListLayout = layout(sessions, errands).layout;
    return {...initialSessionListState, layout: laid, ...extra};
}

const NONE = new Set<string>();

test('a folded shelf hides its rows, except the ones that need you', () => {
    /* Given */
    const state = shelf([errand('x', true), errand('y')]);

    /* When */
    const shown = shownTargets(cursorTargets(state, NONE));

    /* Then: x also asks in Blocked */
    assert.deepEqual(shown, [si('x'), si('a'), si('b'), er('x')]);
});

test('an open shelf shows every row, under the list', () => {
    /* Given */
    const state = shelf([errand('x', true), errand('y')], {errandShelfOpen: true});

    /* When */
    const shown = shownTargets(cursorTargets(state, NONE));

    /* Then */
    assert.deepEqual(shown, [si('x'), si('a'), si('b'), er('x'), er('y')]);
});

test('↓ past the list’s last target walks into a folded shelf and unfolds it', () => {
    /* Given: nothing on the shelf peeks out */
    const state = shelf([errand('x'), errand('y')]);
    const targets = cursorTargets(state, NONE);

    /* When */
    const next = stepCursor(targets, si('b'), 1);

    /* Then */
    assert.equal(next, er('x'));
    assert.equal(opensShelf(state, targets, next!), true);
});

test('↓ walks the shelf and stops at its last row', () => {
    /* Given */
    const state = shelf([errand('x'), errand('y')], {errandShelfOpen: true});
    const targets = cursorTargets(state, NONE);

    /* When */
    const second = stepCursor(targets, er('x'), 1);
    const past = stepCursor(targets, er('y'), 1);

    /* Then */
    assert.equal(second, er('y'));
    assert.equal(past, er('y'));
    assert.equal(opensShelf(state, targets, er('y')), false);
});

test('↑ from the shelf’s first row goes back to the list’s last target', () => {
    /* Given */
    const state = shelf([errand('x'), errand('y')], {errandShelfOpen: true});

    /* When */
    const next = stepCursor(cursorTargets(state, NONE), er('x'), -1);

    /* Then */
    assert.equal(next, si('b'));
});

test('a list row is no reason to unfold the shelf', () => {
    /* Given */
    const state = shelf([errand('x')]);

    /* When */
    const opens = opensShelf(state, cursorTargets(state, NONE), si('a'));

    /* Then */
    assert.equal(opens, false);
});

test('a shelf row sliding out is no stop', () => {
    /* Given */
    const state = shelf([errand('x'), errand('y')], {leaving: {[er('x')]: true}});

    /* When */
    const next = stepCursor(cursorTargets(state, NONE), si('b'), 1);

    /* Then */
    assert.equal(next, er('y'));
});

test('session navigation takes in the shelf, a stuck errand once, in Blocked', () => {
    /* Given */
    const state = shelf([errand('x', true), errand('y')]);

    /* When */
    const order = rowOrder(cursorTargets(state, NONE));

    /* Then */
    assert.deepEqual(order, ['x', 'a', 'b', 'y']);
});

test('focusing the list on an errand on screen lands on its shelf row', () => {
    /* Given */
    const state = shelf([errand('y')]);

    /* When */
    const start = startTarget(state, cursorTargets(state, NONE), 'y');

    /* Then */
    assert.equal(start, er('y'));
});
