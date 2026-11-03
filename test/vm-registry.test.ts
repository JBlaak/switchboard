import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SettingsService} from '../src/application/services/settings-service';
import {migrateVmHosts, vmHostLabel, withDerivedAgent} from '../src/domain/settings/vm-hosts';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {GlobalSettings, RemoteProjectSetting} from '../src/domain/settings/settings';

/**
 * The VM registry in settings (#307): VMs registered on their own, the
 * one-off migration from the remotes older builds marked with `agent`, and
 * `agent` on a remote derived from its host's registration.
 */

const OLD = {version: '2.11.0', installedAt: '2026-10-01T00:00:00.000Z'};
const NEW = {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'};
const VM = {user: 'dev', host: 'vm.local', port: 22};

class MemoryStore implements SettingsStore {
    private readonly values = new Map<string, unknown>();

    public get<T = unknown>(key: string): T | null {
        const value = this.values.get(key);
        return value === undefined ? null : (structuredClone(value) as T);
    }

    public set(key: string, value: unknown): void {
        this.values.set(key, structuredClone(value));
    }

    public delete(key: string): void {
        this.values.delete(key);
    }
}

function settingsWith(global: GlobalSettings): SettingsService {
    const settings = new SettingsService(new MemoryStore());
    settings.saveGlobal(global);
    return settings;
}

function remote(over: Partial<RemoteProjectSetting> = {}): RemoteProjectSetting {
    return {...VM, dir: '~/projects/site', ...over};
}

// ── Migration ──

test('the first read registers every host whose old remotes carried an agent, keeping the version', () => {
    /* Given */
    const settings = settingsWith({
        remoteProjects: [
            remote({agent: OLD}),
            remote({dir: '~/projects/other', agent: OLD}),
            remote({host: 'box', agent: undefined}),
            remote({host: 'build', port: 2222, agent: NEW}),
        ],
    });

    /* When */
    const hosts = settings.vmHosts();

    /* Then */
    assert.deepEqual(hosts, [
        {...VM, addedAt: OLD.installedAt, agent: OLD},
        {user: 'dev', host: 'build', port: 2222, addedAt: NEW.installedAt, agent: NEW},
    ]);
    assert.deepEqual(settings.global().vmHosts, hosts, 'stored, so it happens once');
});

test('the migration runs once: a registry emptied since is not filled in again', () => {
    /* Given */
    const settings = settingsWith({remoteProjects: [remote({agent: OLD})]});
    settings.vmHosts();
    settings.removeVmHost(VM);

    /* When */
    const hosts = settings.vmHosts();

    /* Then */
    assert.deepEqual(hosts, []);
    assert.equal(settings.findRemoteProject('ssh://dev@vm.local/~/projects/site')?.agent, undefined);
});

test('of two old remotes on one host that disagree, the newest install wins', () => {
    /* Given */
    const remotes = [remote({agent: OLD}), remote({dir: 'b', agent: NEW})];

    /* When */
    const hosts = migrateVmHosts(remotes);

    /* Then */
    assert.equal(hosts.length, 1);
    assert.deepEqual(hosts[0].agent, NEW);
});

test('an install with no agent remotes migrates to an empty registry', () => {
    /* Given */
    const settings = settingsWith({remoteProjects: [remote()]});

    /* When */
    const hosts = settings.vmHosts();

    /* Then */
    assert.deepEqual(hosts, []);
    assert.deepEqual(settings.global().vmHosts, []);
});

// ── The derived agent ──

test("a remote on a registered VM with an agent reads with that VM's agent", () => {
    /* Given */
    const settings = settingsWith({
        vmHosts: [{...VM, addedAt: NEW.installedAt, agent: NEW}],
        remoteProjects: [remote()],
    });

    /* When */
    const found = settings.findRemoteProject('ssh://dev@vm.local/~/projects/site');

    /* Then */
    assert.deepEqual(found?.agent, NEW);
    assert.deepEqual(settings.remoteProjects()[0].agent, NEW);
});

test('a stale stored agent is ignored when the host is not registered', () => {
    /* Given */
    const settings = settingsWith({vmHosts: [], remoteProjects: [remote({agent: OLD})]});

    /* When */
    const found = settings.findRemoteProject('ssh://dev@vm.local/~/projects/site');

    /* Then */
    assert.ok(found);
    assert.equal('agent' in found, false);
});

test('a stale stored agent is ignored when the registered VM has no agent yet', () => {
    /* Given */
    const settings = settingsWith({
        vmHosts: [{...VM, addedAt: NEW.installedAt}],
        remoteProjects: [remote({agent: OLD})],
    });

    /* When */
    const [found] = settings.remoteProjects();

    /* Then */
    assert.equal(found.agent, undefined);
});

test('a stored agent older than the registration reads as the registration', () => {
    /* Given */
    const settings = settingsWith({
        vmHosts: [{...VM, addedAt: OLD.installedAt, agent: NEW}],
        remoteProjects: [remote({agent: OLD})],
    });

    /* When */
    const [found] = settings.remoteProjects();

    /* Then */
    assert.deepEqual(found.agent, NEW);
});

test('the derivation leaves the stored record as it was', () => {
    /* Given */
    const stored = remote({agent: OLD});

    /* When */
    const derived = withDerivedAgent(stored, []);

    /* Then */
    assert.equal(derived.agent, undefined);
    assert.deepEqual(stored.agent, OLD);
});

test('a port stored as a string or left out still matches its VM', () => {
    /* Given */
    const hosts = [{user: 'dev', host: 'build', port: 22, addedAt: NEW.installedAt, agent: NEW}];
    const odd = {user: 'dev', host: 'build', port: '22' as unknown as number, dir: 'x'};

    /* When */
    const derived = withDerivedAgent(odd, hosts);

    /* Then */
    assert.deepEqual(derived.agent, NEW);
});

// ── Add, rename, remove ──

test('adding a VM registers it with nothing installed, and refuses it a second time', () => {
    /* Given */
    const settings = settingsWith({});

    /* When */
    const first = settings.addVmHost({...VM, name: ' Dev box '}, '2026-11-03T00:00:00.000Z');
    const second = settings.addVmHost({...VM}, '2026-11-04T00:00:00.000Z');

    /* Then */
    assert.equal(first, true);
    assert.equal(second, false);
    assert.deepEqual(settings.vmHosts(), [{...VM, name: 'Dev box', addedAt: '2026-11-03T00:00:00.000Z'}]);
    assert.deepEqual(settings.findVmHost(VM)?.agent, undefined);
});

test('renaming a VM sets its name, and an empty name goes back to its address', () => {
    /* Given */
    const settings = settingsWith({vmHosts: [{...VM, addedAt: NEW.installedAt}]});

    /* When */
    const named = settings.renameVmHost(VM, 'Dev box');
    const label = vmHostLabel(settings.findVmHost(VM)!);
    const cleared = settings.renameVmHost(VM, '  ');

    /* Then */
    assert.equal(named, true);
    assert.equal(label, 'Dev box');
    assert.equal(cleared, true);
    assert.equal(vmHostLabel(settings.findVmHost(VM)!), 'dev@vm.local');
    assert.equal(settings.renameVmHost({...VM, host: 'gone'}, 'x'), false);
});

test("a VM's label shows the port only when it is not 22", () => {
    /* Given */
    const hosts = [VM, {...VM, port: 2222}];

    /* When */
    const labels = hosts.map(vmHostLabel);

    /* Then */
    assert.deepEqual(labels, ['dev@vm.local', 'dev@vm.local:2222']);
});

test('removing a VM takes only its registration out; its remotes stop being VM projects', () => {
    /* Given */
    const settings = settingsWith({
        vmHosts: [{...VM, addedAt: NEW.installedAt, agent: NEW}],
        remoteProjects: [remote()],
    });

    /* When */
    const removed = settings.removeVmHost(VM);
    const again = settings.removeVmHost(VM);

    /* Then */
    assert.equal(removed, true);
    assert.equal(again, false);
    assert.equal(settings.remoteProjects().length, 1);
    assert.equal(settings.remoteProjects()[0].agent, undefined);
});

// ── Marking an install ──

test('an install on an unregistered host registers it, from any path on it', () => {
    /* Given */
    const settings = settingsWith({remoteProjects: [remote()]});

    /* When */
    const marked = settings.markAgentInstalled('ssh://dev@vm.local', NEW.version, NEW.installedAt);

    /* Then */
    assert.equal(marked, true);
    assert.deepEqual(settings.vmHosts(), [{...VM, addedAt: NEW.installedAt, agent: NEW}]);
    assert.deepEqual(settings.remoteProjects()[0].agent, NEW);
});

test('an install on a registered VM keeps its name and registration date', () => {
    /* Given */
    const settings = settingsWith({vmHosts: [{...VM, name: 'Dev box', addedAt: OLD.installedAt, agent: OLD}]});

    /* When */
    settings.markAgentInstalled('ssh://dev@vm.local/~/projects/site', NEW.version, NEW.installedAt);

    /* Then */
    assert.deepEqual(settings.vmHosts(), [{...VM, name: 'Dev box', addedAt: OLD.installedAt, agent: NEW}]);
});

// ── Folders recorded on a VM ──

test("a new folder on a VM is recorded only when the VM is registered with an agent, and the VM's home too", () => {
    /* Given */
    const settings = settingsWith({vmHosts: [{...VM, addedAt: NEW.installedAt, agent: NEW}]});
    const agentless = settingsWith({vmHosts: [{...VM, addedAt: NEW.installedAt}]});

    /* When */
    const home = settings.ensureRemoteProject('ssh://dev@vm.local');
    const worktree = settings.ensureRemoteProject('ssh://dev@vm.local//home/dev/projects/site/.claude/worktrees/x');
    const refused = agentless.ensureRemoteProject('ssh://dev@vm.local');

    /* Then */
    assert.deepEqual(home, {...VM, dir: null, agent: NEW});
    assert.deepEqual(worktree?.agent, NEW);
    assert.equal(refused, null);
    assert.equal(
        settings.global().remoteProjects?.some((r) => r.agent),
        false,
        'no agent stored on the records',
    );
});
