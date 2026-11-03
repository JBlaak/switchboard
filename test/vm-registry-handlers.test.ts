/**
 * Settings → VMs' IPC handlers (#307), against a fake façade: the channel
 * names the UI calls, what reaches the façade from a renderer's arguments,
 * and what they answer before the façade is built.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {EVENT, INVOKE} from '../src/ipc/channels';
import {registerVmRegistryHandlers} from '../src/main/ipc/vm-registry-handlers';
import type {IpcRegistrar, InvokeHandler} from '../src/main/ipc/support/registrar';
import type {Container} from '../src/main/composition-root';
import type {VmHostView, VmRegistry} from '../src/application/services/vm-registry';

const VIEW: VmHostView = {
    key: 'dev@vm.local:22',
    user: 'dev',
    host: 'vm.local',
    port: 22,
    label: 'dev@vm.local',
    agent: null,
    current: false,
    connected: false,
    projects: [],
};

function harness(registry: VmRegistry | undefined) {
    const handlers = new Map<string, InvokeHandler>();
    const ipc: IpcRegistrar = {handle: (channel, handler) => void handlers.set(channel, handler), on: () => {}};
    registerVmRegistryHandlers(ipc, {vmRegistry: registry} as unknown as Container);
    const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
        try {
            return await (handlers.get(channel) as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
            return {ok: false, error: (err as Error).message};
        }
    };
    return {invoke, channels: [...handlers.keys()].sort()};
}

function fakeRegistry() {
    const calls: unknown[][] = [];
    const registry: VmRegistry = {
        list: () => [VIEW],
        add: (input) => {
            calls.push(['add', input]);
            return {ok: true, key: 'dev@vm.local:22'};
        },
        rename: (key, name) => {
            calls.push(['rename', key, name]);
            return true;
        },
        remove: (key) => {
            calls.push(['remove', key]);
            return {ok: true};
        },
    };
    return {registry, calls};
}

test('the channels are the ones the UI calls', () => {
    /* Given */
    const {registry} = fakeRegistry();

    /* When */
    const {channels} = harness(registry);

    /* Then */
    assert.deepEqual(channels, ['vm-registry:add', 'vm-registry:list', 'vm-registry:remove', 'vm-registry:rename']);
    assert.equal(EVENT.vmHostsChanged, 'vm-registry:changed');
});

test('each call reaches the façade, with only the fields a form has', async () => {
    /* Given */
    const fake = fakeRegistry();
    const {invoke} = harness(fake.registry);

    /* When */
    const listed = await invoke(INVOKE.vmRegistryList);
    await invoke(INVOKE.vmRegistryAdd, {user: 'dev', host: 'vm.local', port: '2222', name: 'Dev', extra: 1});
    await invoke(INVOKE.vmRegistryAdd, {user: 'dev', host: 'vm.local', port: ''});
    await invoke(INVOKE.vmRegistryRename, 'dev@vm.local:22', 'Dev box');
    await invoke(INVOKE.vmRegistryRemove, 'dev@vm.local:22');

    /* Then */
    assert.deepEqual(listed, [VIEW]);
    assert.deepEqual(fake.calls, [
        ['add', {user: 'dev', host: 'vm.local', port: 2222, name: 'Dev'}],
        ['add', {user: 'dev', host: 'vm.local'}],
        ['rename', 'dev@vm.local:22', 'Dev box'],
        ['remove', 'dev@vm.local:22'],
    ]);
});

test('arguments of the wrong type are refused before the façade', async () => {
    /* Given */
    const fake = fakeRegistry();
    const {invoke} = harness(fake.registry);

    /* When */
    const renamed = await invoke(INVOKE.vmRegistryRename, 42, 'x');
    const removed = await invoke(INVOKE.vmRegistryRemove, null);

    /* Then */
    assert.equal(renamed, false);
    assert.deepEqual(removed, {ok: false, error: 'Not a VM'});
    assert.deepEqual(fake.calls, []);
});

test('before the façade is built, the list is empty and changes fail with a message', async () => {
    /* Given */
    const {invoke} = harness(undefined);

    /* When */
    const listed = await invoke(INVOKE.vmRegistryList);
    const added = await invoke(INVOKE.vmRegistryAdd, {user: 'dev', host: 'vm.local'});

    /* Then */
    assert.deepEqual(listed, []);
    assert.deepEqual(added, {ok: false, error: 'VMs aren’t available in this build'});
});
