import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SessionRegistry} from '../src/application/model/session-registry';
import {AgentAwareTerminals} from '../src/application/services/agent-client/agent-aware-terminals';
import {AgentClient} from '../src/application/services/agent-client/agent-client';
import {AgentHostsService} from '../src/application/services/agent-hosts-service';
import {AgentInstallerService} from '../src/application/services/agent-installer-service';
import {RemoteConnectionSupervisor} from '../src/application/services/remote-connection-supervisor';
import {SessionLauncher} from '../src/application/services/session-launcher';
import {SessionLifecycle} from '../src/application/services/session-lifecycle';
import {SettingsService} from '../src/application/services/settings-service';
import {AGENT_PROTOCOL_VERSION} from '../src/domain/agent/protocol';
import {vmHostPath} from '../src/domain/agent/vm-paths';
import {agentlessRemoteGuard} from '../src/domain/project/agentless-remote';
import {fakeRenderer, fakeTerminals, fakeTimers, silentLog} from './support/fakes';
import {HOST_SETTINGS, scriptedAgent, settle} from './support/scripted-agent';
import type {AgentDialer} from '../src/application/ports/agent-link';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {SessionLauncherDeps} from '../src/application/services/session-launcher';
import type {GlobalSettings} from '../src/domain/settings/settings';

/**
 * Every per-host call of the `AgentHosts` façade, given a VM's own path
 * (`vmHostPath`, no folder) as Settings → VMs calls them (#307), on a VM
 * registered with no project at all: status, the setup checks, the host
 * settings, and the setup terminal, which opens in the VM's home.
 */

const HOST = {user: 'dev', host: 'vm.local', port: 22};
const VM_PATH = vmHostPath(HOST);
const AGENT = {version: '2.12.0', installedAt: '2026-11-03T00:00:00.000Z'};
const TOOLS = [{tool: 'git' as const, installed: true, version: '2.43'}];

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

/** The façade as the app wires it, over a scripted agent that also answers the setup checks and host settings. */
function harness(global: GlobalSettings) {
    const agent = scriptedAgent();
    agent.greet = 'silent';
    const dialer: AgentDialer = {
        async dial(host) {
            const mac = await agent.dialer.dial(host);
            const pair = agent.current();
            pair.agent.onMessage((message) => {
                if (message.type === 'hello') {
                    pair.agent.send({
                        type: 'welcome',
                        protocol: AGENT_PROTOCOL_VERSION,
                        agentVersion: message.appVersion,
                        settings: HOST_SETTINGS,
                        home: '/home/dev',
                    });
                } else if (message.type === 'check-tools') {
                    pair.agent.send({type: 'tools', requestId: message.requestId, tools: TOOLS, sudo: true});
                } else if (message.type === 'get-host-settings') {
                    pair.agent.send({type: 'host-settings', requestId: message.requestId, settings: HOST_SETTINGS});
                } else if (message.type === 'set-host-settings') {
                    pair.agent.send({
                        type: 'host-settings',
                        requestId: message.requestId,
                        settings: {...HOST_SETTINGS, ...message.settings},
                    });
                }
            });
            return mac;
        },
    };

    const timers = fakeTimers();
    const clock = {now: () => Date.parse('2026-11-03T10:00:00Z')};
    const registry = new SessionRegistry();
    const renderer = fakeRenderer();
    const terminals = new AgentAwareTerminals(fakeTerminals());
    const remote = new RemoteConnectionSupervisor({
        registry,
        terminals,
        renderer,
        timers,
        clock,
        log: silentLog,
        homeDir: '/Users/joris',
    });
    const lifecycle = new SessionLifecycle({registry, terminals, renderer, remote, timers, log: silentLog});
    remote.attach(lifecycle);
    const client = new AgentClient({
        dialer,
        appVersion: '2.12.0',
        registry,
        renderer,
        hooks: {receive: () => ({withdraw() {}}), turnEnded() {}, promptSubmitted() {}, subagentChanged() {}},
        archiveTool: {request: () => ({ok: true, message: ''}), turnEnded() {}},
        timers,
        clock,
        log: silentLog,
    });
    const settings = new SettingsService(new MemoryStore());
    settings.saveGlobal(global);
    const launcher = new SessionLauncher({
        registry,
        terminals,
        shells: {list: () => [], resolve: () => ({id: 'zsh', name: 'zsh', path: '/bin/zsh'})},
        transcripts: {listSessionIds: () => [], readSlug: () => null},
        settings,
        lifecycle,
        remote,
        renderer,
        questions: {settingsFor: () => null},
        git: {worktreeRoot: async () => null},
        clock,
        timers,
        log: silentLog,
        fileExists: () => true,
        agents: client,
    } as unknown as SessionLauncherDeps);
    const installer = new AgentInstallerService({
        provisioner: {
            run: () => Promise.reject(new Error('no ssh in this test')),
            upload: () => Promise.reject(new Error('no ssh in this test')),
        },
        settings,
        bundles: {build: () => Promise.reject(new Error('no bundles in this test'))},
        appVersion: '2.12.0',
        log: silentLog,
        clock,
    });
    const hosts = new AgentHostsService({
        agents: client,
        installer: {
            installedVersion: async (path) => (await installer.status(path)).installed,
            install: (path, onProgress) => installer.install(path, onProgress),
        },
        launcher,
        setupCommand: 'sh ~/.switchboard/setup.sh',
        appVersion: '2.12.0',
        ids: {newId: () => 'setup-1'},
        log: silentLog,
    });
    return {hosts, settings, agent, client};
}

const REGISTERED: GlobalSettings = {vmHosts: [{...HOST, addedAt: AGENT.installedAt, agent: AGENT}]};

test("status on a VM's own path answers from its registration, with no project on it", async () => {
    /* Given */
    const h = harness(REGISTERED);

    /* When */
    const status = await h.hosts.status(VM_PATH);

    /* Then */
    assert.deepEqual(status, {installed: '2.12.0', current: true, connected: false});
    assert.equal(h.agent.dials.length, 0, 'status never dials');
});

test("an unregistered host's path answers no agent", async () => {
    /* Given */
    const h = harness({vmHosts: []});

    /* When */
    const status = await h.hosts.status(VM_PATH);

    /* Then */
    assert.equal(status.installed, null);
});

test("the setup checks and host settings work on a VM's own path", async () => {
    /* Given */
    const h = harness(REGISTERED);

    /* When */
    const tools = await h.hosts.checkTools(VM_PATH);
    const read = await h.hosts.hostSettings(VM_PATH);
    const saved = await h.hosts.setHostSettings(VM_PATH, {baseFolder: '~/work'});

    /* Then */
    assert.deepEqual(tools, {tools: TOOLS, sudo: true});
    assert.deepEqual(read, HOST_SETTINGS);
    assert.deepEqual(saved, {...HOST_SETTINGS, baseFolder: '~/work'});
    assert.deepEqual(h.agent.dialledHosts, [HOST]);
});

test("the setup terminal on a VM's own path opens a shell in its home, listed as the VM's home project", async () => {
    /* Given */
    const h = harness(REGISTERED);

    /* When */
    const opening = h.hosts.openSetupTerminal(VM_PATH);
    await settle();
    const result = await opening;

    /* Then */
    assert.deepEqual(result, {ok: true, sessionId: 'setup-1'});
    const [open] = h.agent.sent('open');
    assert.equal(open.kind, 'shell');
    assert.equal(open.dir, '', 'the agent opens an empty dir in the home folder');
    assert.equal(open.command, 'sh ~/.switchboard/setup.sh');
    const home = h.settings.findRemoteProject(VM_PATH);
    assert.deepEqual(home?.agent, AGENT);
    assert.deepEqual(
        home?.sessions?.map((s) => [s.sessionId, s.kind]),
        [['setup-1', 'shell']],
    );
});

test("a registered VM with an agent and no projects still lets its paths through the services' guard", () => {
    /* Given */
    const h = harness(REGISTERED);
    const agentless = agentlessRemoteGuard(() => h.settings.vmHosts());

    /* When */
    const vm = agentless('ssh://dev@vm.local//home/dev/projects/site');
    const other = agentless('ssh://dev@box/srv');

    /* Then */
    assert.equal(vm, false);
    assert.equal(other, true);
});

test("an install refused on a VM's own path registers nothing", async () => {
    /* Given */
    const h = harness({vmHosts: []});

    /* When */
    const result = await h.hosts.install(VM_PATH);

    /* Then */
    assert.equal(result.ok, false);
    assert.deepEqual(h.settings.vmHosts(), []);
});
