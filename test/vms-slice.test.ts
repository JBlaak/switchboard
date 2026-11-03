/**
 * Settings → VMs in the renderer's store (#307): main's list, which VM is
 * open to its controls, and a call that failed.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {vmFailureIn, vmHostsIn} from '../src/renderer/state/vms-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {VmHostView} from '../src/application/services/vm-registry';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function vmHost(key: string, fields: Partial<VmHostView> = {}): VmHostView {
    const [user, rest] = key.split('@');
    const [host, port] = rest.split(':');
    return {
        key,
        user,
        host,
        port: Number(port),
        label: `${user}@${host}`,
        agent: '2.11.9',
        current: true,
        connected: false,
        projects: [],
        ...fields,
    };
}

const DEV = vmHost('dev@devbox:22');
const CI = vmHost('ci@runner:2222');

// ── The list ──

test('no VMs show until main has answered', () => {
    /* When */
    const state = initialRendererState();

    /* Then */
    assert.equal(state.vms.hosts, null);
    assert.deepEqual(vmHostsIn(state.vms), []);
});

test('main’s list is kept whole, in its order', () => {
    /* When */
    const state = run(initialRendererState(), {type: 'vmHostsLoaded', hosts: [CI, DEV]});

    /* Then */
    assert.deepEqual(vmHostsIn(state.vms), [CI, DEV]);
});

test('a push with a new list replaces the old one', () => {
    /* Given */
    const before = run(initialRendererState(), {type: 'vmHostsLoaded', hosts: [DEV]});

    /* When */
    const after = run(before, {type: 'vmHostsLoaded', hosts: [{...DEV, connected: true}, CI]});

    /* Then */
    assert.deepEqual(
        vmHostsIn(after.vms).map((vm) => [vm.key, vm.connected]),
        [
            ['dev@devbox:22', true],
            ['ci@runner:2222', false],
        ],
    );
});

// ── The open VM ──

test('a row’s click opens its VM, and another click closes it', () => {
    /* Given */
    const listed = run(initialRendererState(), {type: 'vmHostsLoaded', hosts: [DEV, CI]});

    /* When */
    const opened = run(listed, {type: 'vmHostOpened', key: DEV.key});
    const closed = run(opened, {type: 'vmHostOpened', key: null});

    /* Then */
    assert.equal(opened.vms.open, DEV.key);
    assert.equal(closed.vms.open, null);
});

test('a VM just added opens before the list names it, and stays open once it does', () => {
    /* Given */
    const listed = run(initialRendererState(), {type: 'vmHostsLoaded', hosts: [DEV]});

    /* When */
    const added = run(listed, {type: 'vmHostAdded', key: CI.key});
    const stale = run(added, {type: 'vmHostsLoaded', hosts: [DEV]});
    const fresh = run(stale, {type: 'vmHostsLoaded', hosts: [DEV, CI]});

    /* Then */
    assert.equal(added.vms.open, CI.key);
    assert.equal(stale.vms.open, CI.key);
    assert.equal(fresh.vms.open, CI.key);
});

test('a VM that leaves the list closes', () => {
    /* Given */
    const open = run(
        initialRendererState(),
        {type: 'vmHostsLoaded', hosts: [DEV, CI]},
        {type: 'vmHostOpened', key: CI.key},
    );

    /* When */
    const removed = run(open, {type: 'vmHostsLoaded', hosts: [DEV]});

    /* Then */
    assert.equal(removed.vms.open, null);
});

// ── Failures ──

test('a failed call is kept for its own kind only', () => {
    /* When */
    const state = run(initialRendererState(), {type: 'vmCallFailed', call: 'add', message: 'Host refused'});

    /* Then */
    assert.equal(vmFailureIn(state.vms, 'add'), 'Host refused');
    assert.equal(vmFailureIn(state.vms, 'remove'), null);
});

test('trying the same call again clears why it failed; another call leaves it', () => {
    /* Given */
    const failed = run(initialRendererState(), {type: 'vmCallFailed', call: 'add', message: 'Host refused'});

    /* When */
    const other = run(failed, {type: 'vmCallStarted', call: 'rename'});
    const again = run(failed, {type: 'vmCallStarted', call: 'add'});

    /* Then */
    assert.equal(vmFailureIn(other.vms, 'add'), 'Host refused');
    assert.equal(vmFailureIn(again.vms, 'add'), null);
});

test('a VM added clears why an add failed', () => {
    /* Given */
    const failed = run(initialRendererState(), {type: 'vmCallFailed', call: 'add', message: 'Host refused'});

    /* When */
    const added = run(failed, {type: 'vmHostAdded', key: DEV.key});

    /* Then */
    assert.equal(added.vms.failure, null);
});
