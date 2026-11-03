/**
 * The stage 5 IPC handlers (#276): where schedules run and moving them, a
 * drop's upload, and the hand-off carrying the dialog's choices, each
 * against a fake façade, and what they answer before the façade is built.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {INVOKE} from '../src/ipc/channels';
import {registerVmSchedulesHandlers} from '../src/main/ipc/vm-schedules-handlers';
import {registerDroppedFilesHandlers} from '../src/main/ipc/dropped-files-handlers';
import {handoffChoices, registerHandoffHandlers} from '../src/main/ipc/handoff-handlers';
import type {IpcRegistrar, InvokeHandler} from '../src/main/ipc/support/registrar';
import type {Container} from '../src/main/composition-root';
import type {ScheduleLocation, VmSchedules} from '../src/application/services/vm-schedules';
import type {DroppedFiles} from '../src/application/services/dropped-files';

const LOCAL = '/Users/me/code/app';
const COPY = 'ssh://dev@buildbox/home/dev/projects/app';
const ON_COPY: ScheduleLocation = {localPath: LOCAL, runsOn: {kind: 'vm', copyPath: COPY}, count: 2};

/** The registrar as main's: a thrown error answers `{ ok: false, error }`. */
function fakeIpc() {
    const handlers = new Map<string, InvokeHandler>();
    const ipc: IpcRegistrar = {
        handle: (channel, handler) => {
            handlers.set(channel, handler);
        },
        on: () => {},
    };
    const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error('No handler for ' + channel);
        try {
            return await (handler as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
            return {ok: false, error: (err as Error).message};
        }
    };
    return {ipc, invoke};
}

function setup(fields: Partial<Record<'vmSchedules' | 'droppedFiles' | 'projectHandoff', unknown>> = {}) {
    const {ipc, invoke} = fakeIpc();
    const app = {
        getWindow: () => null,
        renderer: {projectsChanged: () => {}},
        ...fields,
    } as unknown as Container;
    registerVmSchedulesHandlers(ipc, app);
    registerDroppedFilesHandlers(ipc, app);
    registerHandoffHandlers(ipc, app);
    return invoke;
}

function fakeSchedules() {
    const calls: unknown[][] = [];
    const schedules: VmSchedules = {
        where: async (path) => {
            calls.push(['where', path]);
            return ON_COPY;
        },
        runOn: async (localPath, copyPath) => {
            calls.push(['runOn', localPath, copyPath]);
            return ON_COPY;
        },
    };
    return {schedules, calls};
}

// ── Where schedules run ──

test('where asks the façade for a local project or a copy', async () => {
    /* Given */
    const {schedules, calls} = fakeSchedules();
    const invoke = setup({vmSchedules: schedules});

    /* When */
    const local = await invoke(INVOKE.vmSchedulesWhere, LOCAL);
    const copy = await invoke(INVOKE.vmSchedulesWhere, COPY);

    /* Then */
    assert.deepEqual([local, copy], [ON_COPY, ON_COPY]);
    assert.deepEqual(calls, [
        ['where', LOCAL],
        ['where', COPY],
    ]);
});

test('before the façade is built, where answers null, so no line shows', async () => {
    /* Given */
    const invoke = setup();

    /* When */
    const answer = await invoke(INVOKE.vmSchedulesWhere, LOCAL);

    /* Then */
    assert.equal(answer, null);
});

test('runOn moves them to a copy or back to the Mac', async () => {
    /* Given */
    const {schedules, calls} = fakeSchedules();
    const invoke = setup({vmSchedules: schedules});

    /* When */
    await invoke(INVOKE.vmSchedulesRunOn, LOCAL, COPY);
    await invoke(INVOKE.vmSchedulesRunOn, LOCAL, null);

    /* Then */
    assert.deepEqual(calls, [
        ['runOn', LOCAL, COPY],
        ['runOn', LOCAL, null],
    ]);
});

test('runOn turns down a remote as the local project, or a local folder as the copy', async () => {
    /* Given */
    const {schedules, calls} = fakeSchedules();
    const invoke = setup({vmSchedules: schedules});

    /* When */
    const remote = await invoke(INVOKE.vmSchedulesRunOn, COPY, null);
    const local = await invoke(INVOKE.vmSchedulesRunOn, LOCAL, '/elsewhere');

    /* Then */
    assert.deepEqual(remote, {ok: false, error: 'Not a local project'});
    assert.deepEqual(local, {ok: false, error: 'Not a copy on a VM'});
    assert.deepEqual(calls, []);
});

// ── Dropped files ──

test('a drop’s upload goes to the façade with the session and its paths', async () => {
    /* Given */
    const calls: unknown[][] = [];
    const droppedFiles: DroppedFiles = {
        toSession: async (sessionId, paths) => {
            calls.push([sessionId, paths]);
            return {ok: true, paths: ['/tmp/sb/a.png']};
        },
    };
    const invoke = setup({droppedFiles});

    /* When */
    const answer = await invoke(INVOKE.droppedFilesToSession, 's1', ['/Users/me/a.png', 3]);

    /* Then */
    assert.deepEqual(answer, {ok: true, paths: ['/tmp/sb/a.png']});
    assert.deepEqual(calls, [['s1', ['/Users/me/a.png']]]);
});

test('before the façade is built, a drop’s upload answers an error', async () => {
    /* Given */
    const invoke = setup();

    /* When */
    const answer = await invoke(INVOKE.droppedFilesToSession, 's1', ['/Users/me/a.png']);

    /* Then */
    assert.deepEqual(answer, {ok: false, error: 'Uploading to a VM isn’t available in this build'});
});

// ── The hand-off's choices ──

test('the hand-off passes the dialog’s schedules choice to the façade', async () => {
    /* Given */
    const calls: unknown[][] = [];
    const projectHandoff = {
        handOff: async (...args: unknown[]) => {
            calls.push(args);
            return {ok: true, copyPath: COPY, reused: false};
        },
    };
    const invoke = setup({projectHandoff});

    /* When */
    await invoke(INVOKE.handoffRun, LOCAL, 'dev@buildbox:22', ['.env'], {schedulesOnVm: false});

    /* Then */
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][4], {schedulesOnVm: false});
});

test('only a boolean schedules choice crosses; anything else is no choice', () => {
    /* When */
    const choices = [
        handoffChoices({schedulesOnVm: true}),
        handoffChoices({schedulesOnVm: 'yes', other: 1}),
        handoffChoices(undefined),
    ];

    /* Then */
    assert.deepEqual(choices, [{schedulesOnVm: true}, {}, {}]);
});
