/**
 * What the project pages do about schedules (#276 stage 5), against a fake
 * `window.api`: asking where they run, and moving them, with main's error
 * shown. (The hand-off's choice crossing to main is in the handler tests.)
 */
import {beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatch, getState} from '../src/renderer/state/app-store';
import {schedulesIn} from '../src/renderer/state/handoff-slice';
import {loadSchedules, moveSchedules} from '../src/renderer/ui/project-page/schedules-actions';
import {ON_MAC} from '../src/renderer/ui/project-page/schedules-view';
import type {ScheduleLocation} from '../src/application/services/vm-schedules';

const LOCAL = '/Users/me/code/app';
const COPY = 'ssh://dev@buildbox/home/dev/projects/app';
const ON_THE_MAC: ScheduleLocation = {localPath: LOCAL, runsOn: {kind: 'mac'}, count: 2};
const ON_COPY: ScheduleLocation = {localPath: LOCAL, runsOn: {kind: 'vm', copyPath: COPY}, count: 2};

/** A main that answers each call by its method's handler, recording every call. */
function installMain(handlers: Record<string, (...args: unknown[]) => unknown>): {calls: [string, ...unknown[]][]} {
    const calls: [string, ...unknown[]][] = [];
    const api = new Proxy(
        {},
        {
            get:
                (_target, method: string) =>
                async (...args: unknown[]) => {
                    calls.push([method, ...args]);
                    const handler = handlers[method];
                    return handler ? handler(...args) : undefined;
                },
        },
    );
    Object.assign(globalThis, {window: {api}});
    return {calls};
}

beforeEach(() => {
    dispatch({type: 'schedulesLoaded', projectPath: LOCAL, location: null});
    installMain({});
});

test('a page asks main where its project’s schedules run', async () => {
    /* Given */
    const main = installMain({schedulesWhere: () => ON_THE_MAC});

    /* When */
    await loadSchedules(LOCAL);

    /* Then */
    assert.deepEqual(main.calls, [['schedulesWhere', LOCAL]]);
    assert.deepEqual(schedulesIn(getState().handoff, LOCAL).location, ON_THE_MAC);
});

test('an answer that isn’t a location shows no line', async () => {
    /* Given */
    installMain({schedulesWhere: () => ({ok: false, error: 'boom'})});

    /* When */
    await loadSchedules(LOCAL);

    /* Then */
    assert.equal(schedulesIn(getState().handoff, LOCAL).location, null);
});

test('moving the schedules to a copy tells main, and the page follows its answer', async () => {
    /* Given */
    const main = installMain({runSchedulesOn: () => ON_COPY});
    await loadSchedules(LOCAL);

    /* When */
    await moveSchedules(LOCAL, LOCAL, COPY);

    /* Then */
    assert.deepEqual(main.calls.at(-1), ['runSchedulesOn', LOCAL, COPY]);
    assert.deepEqual(schedulesIn(getState().handoff, LOCAL), {location: ON_COPY, moving: false, error: null});
});

test('moving them back to the Mac tells main null', async () => {
    /* Given */
    const main = installMain({runSchedulesOn: () => ON_THE_MAC});

    /* When */
    await moveSchedules(COPY, LOCAL, ON_MAC);

    /* Then */
    assert.deepEqual(main.calls.at(-1), ['runSchedulesOn', LOCAL, null]);
});

test('a move main couldn’t make shows its error', async () => {
    /* Given */
    installMain({runSchedulesOn: () => ({error: 'Couldn’t reach the VM'})});

    /* When */
    await moveSchedules(LOCAL, LOCAL, COPY);

    /* Then */
    assert.equal(schedulesIn(getState().handoff, LOCAL).error, 'Couldn’t reach the VM');
});

test('a move whose call fails says the VM couldn’t be reached', async () => {
    /* Given */
    installMain({runSchedulesOn: () => undefined});

    /* When */
    await moveSchedules(LOCAL, LOCAL, COPY);

    /* Then */
    assert.equal(schedulesIn(getState().handoff, LOCAL).error, 'Couldn’t reach the VM');
});
