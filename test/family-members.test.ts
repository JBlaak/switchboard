/**
 * Who is out with the Patch family on the empty screen (state/family-members):
 * one member per session with a live terminal, posed for its activity, the
 * ones waiting on the user in front.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState} from '../src/renderer/state/root';
import {FAMILY_SIZE, familyMembersIn} from '../src/renderer/state/family-members';
import type {RendererState} from '../src/renderer/state/root';
import type {SessionRow} from '../src/domain/session/session';

function row(id: string, name: string, projectPath = '/Users/me/Development/switchboard'): SessionRow {
    return {sessionId: id, name, aiTitle: null, summary: '', projectPath} as unknown as SessionRow;
}

function stateWith(
    live: string[],
    activity: {busy?: string[]; attention?: string[]; ready?: string[]; agents?: Record<string, number>} = {},
): RendererState {
    const base = initialRendererState();
    const flag = (ids: string[] = []): Record<string, true> => Object.fromEntries(ids.map((id) => [id, true as const]));
    const agents = Object.fromEntries(
        Object.entries(activity.agents ?? {}).map(([id, n]) => [
            id,
            Array.from({length: n}, (_, i) => ({id: `${id}-agent-${i}`})),
        ]),
    );
    return {
        ...base,
        view: {...base.view, activePtyIds: new Set(live)},
        activity: {
            ...base.activity,
            busy: flag(activity.busy),
            attention: flag(activity.attention),
            ready: flag(activity.ready),
            agents,
        },
    };
}

test('only sessions with a live terminal join the family', () => {
    /* Given */
    const state = stateWith(['a']);

    /* When */
    const members = familyMembersIn(state, [row('a', 'Tray epic'), row('b', 'Old notes')]);

    /* Then */
    assert.deepEqual(
        members.map((m) => m.id),
        ['a'],
    );
});

test('each member is posed for what its session is doing, with its agents as helpers', () => {
    /* Given */
    const state = stateWith(['busy', 'asks', 'done', 'rest'], {
        busy: ['busy'],
        attention: ['asks'],
        ready: ['done'],
        agents: {busy: 3},
    });

    /* When */
    const members = familyMembersIn(state, [row('busy', 'B'), row('asks', 'A'), row('done', 'D'), row('rest', 'R')]);

    /* Then */
    const byId = Object.fromEntries(members.map((m) => [m.id, m]));
    assert.equal(byId.busy!.status, 'working');
    assert.equal(byId.busy!.helpers, 3);
    assert.equal(byId.asks!.status, 'blocked');
    assert.equal(byId.done!.status, 'ready');
    assert.equal(byId.rest!.status, 'idle');
});

test('waiting on the user outranks being busy, so a blocked session that is still busy asks for you', () => {
    /* Given */
    const state = stateWith(['a'], {busy: ['a'], attention: ['a']});

    /* When */
    const [member] = familyMembersIn(state, [row('a', 'Release')]);

    /* Then */
    assert.equal(member!.status, 'blocked');
});

test('the front of the family is whoever needs the user, then the busiest', () => {
    /* Given */
    const state = stateWith(['idle', 'one', 'three', 'asks', 'done'], {
        busy: ['one', 'three'],
        attention: ['asks'],
        ready: ['done'],
        agents: {one: 1, three: 3},
    });

    /* When */
    const members = familyMembersIn(
        state,
        ['idle', 'one', 'three', 'asks', 'done'].map((id) => row(id, id)),
    );

    /* Then */
    assert.deepEqual(
        members.map((m) => m.id),
        ['asks', 'three', 'one', 'done', 'idle'],
    );
});

test('no more than nine go out', () => {
    /* Given */
    const ids = Array.from({length: 12}, (_, i) => `s${String(i).padStart(2, '0')}`);
    const state = stateWith(ids);

    /* When */
    const members = familyMembersIn(
        state,
        ids.map((id) => row(id, id)),
    );

    /* Then */
    assert.equal(members.length, FAMILY_SIZE);
});

test('a long title is cut down, and the tag names the project folder and what it is doing', () => {
    /* Given */
    const state = stateWith(['a'], {busy: ['a'], agents: {a: 2}});

    /* When */
    const [member] = familyMembersIn(state, [
        row('a', 'Build the session tray with saved prompts and links', '/Users/me/Development/JBlaak/switchboard'),
    ]);

    /* Then */
    assert.equal(member!.name, 'Build the session tray with…');
    assert.equal(member!.detail, 'switchboard · Working · 2 agents');
});

test('a session without a title goes by its project folder', () => {
    /* Given */
    const state = stateWith(['a']);

    /* When */
    const [member] = familyMembersIn(state, [row('a', '', '/Users/me/Development/patch')]);

    /* Then */
    assert.equal(member!.name, 'patch');
});

test('a snoozed session stays home, and joins again once it wakes', () => {
    /* Given */
    const state = stateWith(['awake', 'asleep', 'woken']);
    const now = Date.parse('2026-11-07T10:00:00Z');
    const rows = [
        row('awake', 'Awake'),
        {...row('asleep', 'Asleep'), snoozedUntil: '2026-11-07T15:00:00Z'},
        {...row('woken', 'Woken'), snoozedUntil: '2026-11-07T09:00:00Z'},
    ];

    /* When */
    const members = familyMembersIn(state, rows, now);

    /* Then */
    assert.deepEqual(members.map((m) => m.id).sort(), ['awake', 'woken']);
});
