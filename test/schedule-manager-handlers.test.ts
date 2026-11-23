/**
 * The Schedule manager's IPC handlers: every channel is answered, each
 * passes its arguments on checked, and settings of the wrong shape are
 * refused before they reach the service.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {INVOKE} from '../src/ipc/channels';
import {asSettings, registerScheduleManagerHandlers} from '../src/main/ipc/schedule-manager-handlers';
import type {IpcRegistrar, InvokeHandler} from '../src/main/ipc/support/registrar';
import type {Container} from '../src/main/composition-root';
import type {ScheduleSettings} from '../src/domain/schedule/manager';

const SETTINGS: ScheduleSettings = {
    name: 'Nightly check',
    slug: 'nightly-check',
    projectPath: '/Users/me/code/app',
    cron: '0 3 * * *',
    enabled: true,
    prompt: 'Check.',
    model: null,
    permissionMode: 'acceptEdits',
    allowedTools: 'Read',
    limitMinutes: 30,
    weekCap: null,
    missed: 'run-once',
    worktree: true,
};

function setup() {
    const handlers = new Map<string, InvokeHandler>();
    const ipc: IpcRegistrar = {
        handle: (channel, handler) => {
            handlers.set(channel, handler);
        },
        on: () => {},
    };
    const calls: unknown[][] = [];
    const record =
        (name: string) =>
        (...args: unknown[]) => {
            calls.push([name, ...args]);
            return {ok: true};
        };
    const scheduleManager = new Proxy({}, {get: (_t, name: string) => record(name)});
    registerScheduleManagerHandlers(ipc, {scheduleManager} as unknown as Container);
    const invoke = (channel: string, ...args: unknown[]): unknown =>
        (handlers.get(channel) as (...a: unknown[]) => unknown)(...args);
    return {handlers, calls, invoke};
}

test('every Schedule manager channel has a handler', () => {
    /* Given */
    const channels = Object.entries(INVOKE)
        .filter(([name]) => name.startsWith('scheduleManager'))
        .map(([, channel]) => channel);

    /* When */
    const {handlers} = setup();

    /* Then */
    assert.equal(channels.length, 11);
    for (const channel of channels) assert.ok(handlers.has(channel), channel);
});

test('a save passes the key, the settings, the note and whether to try it', () => {
    /* Given */
    const {invoke, calls} = setup();

    /* When */
    invoke(INVOKE.scheduleManagerSave, null, SETTINGS, 'first', true);

    /* Then */
    assert.deepEqual(calls, [['save', null, SETTINGS, 'first', true]]);
});

test('a draft without a project lets Claude pick one', () => {
    /* Given */
    const {invoke, calls} = setup();

    /* When */
    invoke(INVOKE.scheduleManagerDraft, 'check deps nightly', '');

    /* Then */
    assert.deepEqual(calls, [['draft', 'check deps nightly', null]]);
});

test('clearing the wake passes null', () => {
    /* Given */
    const {invoke, calls} = setup();

    /* When */
    invoke(INVOKE.scheduleManagerSetWake, null);

    /* Then */
    assert.deepEqual(calls, [['setWake', null]]);
});

test('settings of the wrong shape are refused', () => {
    /* Then */
    assert.throws(() => asSettings(null));
    assert.throws(() => asSettings({...SETTINGS, enabled: 'yes'}), /settings.enabled/);
    assert.throws(() => asSettings({...SETTINGS, limitMinutes: '30'}), /settings.limitMinutes/);
    assert.throws(() => asSettings({...SETTINGS, missed: 'always'}), /settings.missed/);
    assert.deepEqual(asSettings({...SETTINGS, extra: 1}), SETTINGS);
});
