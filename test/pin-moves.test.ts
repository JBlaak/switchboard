/**
 * Moving a pinned entry within its section (`state/pin-moves`, #379): which
 * entries move, what a drag or ⌥↑ / ⌥↓ asks main for, and where a drag drops.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    cursorEntryId,
    dropSlot,
    entryPins,
    makeRoom,
    pinMove,
    pinnedSectionOf,
    stepPinMove,
} from '../src/renderer/state/pin-moves';
import {TIER_PINNED, TIER_PINNED_PLAN, TIER_PINNED_PROJECT, TIER_REST} from '../src/domain/session/tiers';
import type {LaidEntry, SessionListLayout, SessionListRow} from '../src/renderer/state/session-list-layout';
import type {SessionRow} from '../src/domain/session/session';

function row(id: string, extra: Partial<SessionRow> = {}): SessionListRow {
    const session: SessionRow = {
        sessionId: id,
        summary: id,
        firstPrompt: '',
        projectPath: '/p',
        created: '2026-01-01T00:00:00Z',
        modified: '2026-01-01T00:00:00Z',
        messageCount: 1,
        name: null,
        starred: 1,
        archived: 0,
        ...extra,
    };
    return {kind: 'row', id: 'si-' + id, session, projectPath: '/p'};
}

const pinned = (id: string, extra: Partial<SessionRow> = {}): LaidEntry => ({entry: row(id, extra), tier: TIER_PINNED});

const layoutOf = (visible: LaidEntry[], filtering = false): SessionListLayout => ({visible, older: [], filtering});

const ref = (sessionId: string) => ({kind: 'session', sessionId}) as const;

test('dragging a pinned session up to the top puts it before the first', () => {
    /* Given */
    const entries = [pinned('a'), pinned('b'), pinned('c')];

    /* When */
    const move = pinMove(entries, 2, 0);

    /* Then */
    assert.deepEqual(move, {moving: [ref('c')], target: {before: ref('a')}});
});

test('dragging a pinned session below the last puts it after the last', () => {
    /* Given */
    const entries = [pinned('a'), pinned('b'), pinned('c')];

    /* When */
    const move = pinMove(entries, 0, 2);

    /* Then */
    assert.deepEqual(move, {moving: [ref('a')], target: {after: ref('c')}});
});

test('dropping an entry where it already was moves nothing', () => {
    /* Given */
    const entries = [pinned('a'), pinned('b'), pinned('c')];

    /* When */
    const move = pinMove(entries, 1, 1);

    /* Then */
    assert.equal(move, null);
});

test('⌥↓ moves the entry below its neighbour, and ⌥↑ above it', () => {
    /* Given */
    const layout = layoutOf([pinned('a'), pinned('b'), pinned('c')]);
    const found = pinnedSectionOf(layout, 'si-b')!;

    /* When */
    const down = stepPinMove(found, 1);
    const up = stepPinMove(found, -1);

    /* Then */
    assert.deepEqual(down, {moving: [ref('b')], target: {after: ref('c')}});
    assert.deepEqual(up, {moving: [ref('b')], target: {before: ref('a')}});
});

test('⌥↑ on the first entry and ⌥↓ on the last do nothing', () => {
    /* Given */
    const layout = layoutOf([pinned('a'), pinned('b')]);

    /* When */
    const up = stepPinMove(pinnedSectionOf(layout, 'si-a')!, -1);
    const down = stepPinMove(pinnedSectionOf(layout, 'si-b')!, 1);

    /* Then */
    assert.equal(up, null);
    assert.equal(down, null);
});

test('an entry moves only within its own section', () => {
    /* Given */
    const project: LaidEntry = {
        entry: {kind: 'project', id: 'project-p', projectPath: '/p'},
        tier: TIER_PINNED_PROJECT,
    };
    const layout = layoutOf([project, pinned('a'), pinned('b')]);

    /* When */
    const found = pinnedSectionOf(layout, 'si-a');

    /* Then */
    assert.equal(found?.section, 'sessions');
    assert.deepEqual(
        found?.entries.map((l) => l.entry.id),
        ['si-a', 'si-b'],
    );
    assert.equal(found?.index, 0);
});

test('nothing moves while a filter or a search is on', () => {
    /* Given */
    const layout = layoutOf([pinned('a'), pinned('b')], true);

    /* When */
    const found = pinnedSectionOf(layout, 'si-a');

    /* Then */
    assert.equal(found, null);
});

test('an unpinned row is in no section that moves', () => {
    /* Given */
    const layout = layoutOf([pinned('a'), {entry: row('r', {starred: 0}), tier: TIER_REST}]);

    /* When */
    const found = pinnedSectionOf(layout, 'si-r');

    /* Then */
    assert.equal(found, null);
});

test('a pinned group moves as its pinned sessions, in their order, leaving the unpinned ones out', () => {
    /* Given */
    const group: LaidEntry = {
        entry: {
            kind: 'group',
            id: 'slug-g',
            slug: 'g',
            projectPath: '/p',
            sessions: [row('new', {pinPosition: 4}), row('loose', {starred: 0}), row('old', {pinPosition: 1})],
        },
        tier: TIER_PINNED,
    };

    /* When */
    const pins = entryPins(group);

    /* Then */
    assert.deepEqual(pins, [ref('old'), ref('new')]);
});

test('a group under Pinned plans moves as its plan, and a GitHub plan as its issue', () => {
    /* Given */
    const slugPlan: LaidEntry = {
        entry: {kind: 'group', id: 'slug-g', slug: 'g', projectPath: '/p', sessions: [row('s')]},
        tier: TIER_PINNED_PLAN,
    };
    const issuePlan: LaidEntry = {
        entry: {kind: 'plan', id: 'plan-x', projectPath: '/p', repository: 'o/r', number: 7, title: 'Epic'},
        tier: TIER_PINNED_PLAN,
    };

    /* When */
    const move = pinMove([slugPlan, issuePlan], 1, 0);

    /* Then */
    assert.deepEqual(move, {
        moving: [{kind: 'issuePlan', projectPath: '/p', repository: 'o/r', number: 7}],
        target: {before: {kind: 'plan', projectPath: '/p', slug: 'g'}},
    });
});

test('a drag drops below every middle it has passed', () => {
    /* Given: the other entries' middles, top to bottom */
    const middles = [100, 140, 180];

    /* When */
    const slots = [90, 120, 150, 200].map((y) => dropSlot(middles, y));

    /* Then */
    assert.deepEqual(slots, [0, 1, 2, 3]);
});

test('while a drag hovers a slot, the entries it passes make room and the rest stay put', () => {
    /* Given: five entries 40 px apart; the one at 3 is dragged */
    const shifts = (slot: number): number[] => [0, 1, 2, 4].map((n) => makeRoom(n, 3, slot, 40));

    /* When */
    const up = shifts(1);
    const down = shifts(4);
    const home = shifts(3);

    /* Then */
    assert.deepEqual(up, [0, 40, 40, 0]);
    assert.deepEqual(down, [0, 0, 0, -40]);
    assert.deepEqual(home, [0, 0, 0, 0]);
});

test('a row in a group, or its header, moves the group; labels and toggles move nothing', () => {
    /* When */
    const ids = [
        cursorEntryId({kind: 'row', name: 'si-a', shown: true, sessionId: 'a', groupId: 'slug-g'}),
        cursorEntryId({kind: 'header', name: 'header:slug-g', shown: true, groupId: 'slug-g'}),
        cursorEntryId({kind: 'row', name: 'si-b', shown: true, sessionId: 'b'}),
        cursorEntryId({kind: 'section', name: 'section-7', shown: true, tier: TIER_PINNED_PROJECT}),
        cursorEntryId({kind: 'older', name: 'older-all', shown: true}),
    ];

    /* Then */
    assert.deepEqual(ids, ['slug-g', 'slug-g', 'si-b', null, null]);
});
