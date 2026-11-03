import {test} from 'node:test';
import assert from 'node:assert/strict';

import {ActiveSession} from '../src/application/model/active-session';
import {SessionRegistry} from '../src/application/model/session-registry';
import {AgentPty} from '../src/application/services/agent-client/agent-pty';
import {SessionLifecycle} from '../src/application/services/session-lifecycle';
import {SettingsService} from '../src/application/services/settings-service';
import {VmRegistryService} from '../src/application/services/vm-registry-service';
import {forgetRemoteProject} from '../src/main/forget-remote-project';
import {agentHostKey} from '../src/application/services/agent-client/agent-client';
import {fakePty, fakeRenderer, fakeTerminals, fakeTimers, silentLog} from './support/fakes';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {RemoteObserver} from '../src/application/services/session-lifecycle';
import type {GlobalSettings} from '../src/domain/settings/settings';
import type {VmHost} from '../src/domain/agent/vm-paths';
import type {PtyHandle} from '../src/application/ports/terminal-gateway';

/**
 * Settings → VMs' façade (#307): the views it lists, registering a typed
 * address, renaming, and removing a VM, which forgets its projects here
 * without stopping a single session on the VM.
 */

const AGENT = {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'};
const DEV = {user: 'dev', host: 'vm.local', port: 22};
const BUILD = {user: 'ci', host: 'build', port: 2222};
const SITE = 'ssh://dev@vm.local/~/projects/site';
const HOME = 'ssh://dev@vm.local';

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

const noRemote: RemoteObserver = {observeOutput() {}, handleExit: () => false, markDisconnected() {}};

function harness(global: GlobalSettings = {}, connected: string[] = []) {
    const settings = new SettingsService(new MemoryStore());
    settings.saveGlobal(global);
    const renderer = fakeRenderer();
    const registry = new SessionRegistry();
    const terminals = fakeTerminals();
    const lifecycle = new SessionLifecycle({
        registry,
        terminals,
        renderer,
        remote: noRemote,
        timers: fakeTimers(),
        log: silentLog,
    });
    const released: string[] = [];
    const disconnected: string[] = [];
    const dialled: string[] = [];
    const agents = {
        connection: (host: VmHost) => ({connected: connected.includes(agentHostKey(host))}),
        disconnect: (host: VmHost) => void disconnected.push(agentHostKey(host)),
        release: (pty: AgentPty) => void released.push(pty.sessionId),
        retryNow: () => void dialled.push('dial'),
    };
    const forget = (projectPath: string) =>
        forgetRemoteProject({settings, registry, remote: noRemote, lifecycle, renderer, agents}, projectPath);
    const service = new VmRegistryService({
        settings,
        agents,
        forgetRemoteProject: forget,
        renderer,
        appVersion: '2.12.0',
        clock: {now: () => Date.parse('2026-11-03T12:00:00.000Z')},
        log: silentLog,
    });

    /** A VM session whose signals are recorded where they would go over the link. */
    const vmSession = (sessionId: string, projectPath: string) => {
        const signals: string[] = [];
        const pty = new AgentPty({
            sessionId,
            hostKey: 'dev@vm.local:22',
            kind: 'claude',
            cols: 80,
            rows: 24,
            sink: {input() {}, resize() {}, signal: (_id, signal) => void signals.push(signal)},
        });
        registry.add(sessionId, session(pty, projectPath));
        return signals;
    };
    const localSession = (sessionId: string, projectPath: string) =>
        registry.add(sessionId, session(fakePty(), projectPath));

    return {
        service,
        settings,
        renderer,
        registry,
        terminals,
        released,
        disconnected,
        dialled,
        vmSession,
        localSession,
    };
}

function session(pty: PtyHandle, projectPath: string): ActiveSession {
    return new ActiveSession({
        pty,
        projectPath,
        projectFolder: null,
        knownTranscriptIds: null,
        sessionSlug: null,
        isPlainTerminal: false,
        remote: null,
        openedAt: 0,
    });
}

// ── list ──

test('each VM is listed with its label, agent, link and projects, without dialling', () => {
    /* Given */
    const h = harness(
        {
            vmHosts: [
                {...DEV, name: 'Dev box', addedAt: AGENT.installedAt, agent: AGENT},
                {...BUILD, addedAt: AGENT.installedAt, agent: {version: '2.11.0', installedAt: AGENT.installedAt}},
                {user: 'new', host: 'fresh', port: 22, addedAt: AGENT.installedAt},
            ],
            remoteProjects: [
                {...DEV, dir: '~/projects/site'},
                {...DEV, dir: null},
                {...BUILD, dir: 'ci'},
                {user: 'other', host: 'box', port: 22, dir: 'x'},
            ],
        },
        ['dev@vm.local:22'],
    );

    /* When */
    const views = h.service.list();

    /* Then */
    assert.deepEqual(views, [
        {
            key: 'dev@vm.local:22',
            ...DEV,
            label: 'Dev box',
            agent: '2.12.0',
            current: true,
            connected: true,
            projects: [SITE, HOME],
        },
        {
            key: 'ci@build:2222',
            ...BUILD,
            label: 'ci@build:2222',
            agent: '2.11.0',
            current: false,
            connected: false,
            projects: ['ssh://ci@build:2222/ci'],
        },
        {
            key: 'new@fresh:22',
            user: 'new',
            host: 'fresh',
            port: 22,
            label: 'new@fresh',
            agent: null,
            current: false,
            connected: false,
            projects: [],
        },
    ]);
    assert.deepEqual(h.dialled, []);
});

// ── add ──

test('adding a VM registers it with port 22 by default, and says the list changed', () => {
    /* Given */
    const h = harness();

    /* When */
    const result = h.service.add({user: ' dev ', host: 'vm.local', name: 'Dev box'});

    /* Then */
    assert.deepEqual(result, {ok: true, key: 'dev@vm.local:22'});
    assert.deepEqual(h.settings.vmHosts(), [{...DEV, name: 'Dev box', addedAt: '2026-11-03T12:00:00.000Z'}]);
    assert.equal(h.renderer.only('vmHostsChanged').length, 1);
});

test('a VM already registered is refused, port 22 written or not', () => {
    /* Given */
    const h = harness({vmHosts: [{...DEV, addedAt: AGENT.installedAt}]});

    /* When */
    const result = h.service.add({user: 'dev', host: 'vm.local', port: 22});

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'dev@vm.local is already registered.'});
    assert.equal(h.settings.vmHosts().length, 1);
    assert.equal(h.renderer.only('vmHostsChanged').length, 0);
});

test('a bad address is refused with the message the form shows, and nothing is registered', () => {
    /* Given */
    const h = harness();

    /* When */
    const results = [
        h.service.add({user: 'dev; rm -rf', host: 'vm.local'}),
        h.service.add({user: 'dev', host: ''}),
        h.service.add({user: 'dev', host: 'vm.local', port: 70000}),
    ];

    /* Then */
    assert.deepEqual(
        results.map((r) => r.ok),
        [false, false, false],
    );
    assert.match(results[0].ok ? '' : results[0].error, /Username/);
    assert.match(results[1].ok ? '' : results[1].error, /Host/);
    assert.match(results[2].ok ? '' : results[2].error, /Port/);
    assert.deepEqual(h.settings.vmHosts(), []);
});

// ── rename ──

test('renaming a VM by its key changes its label; an unknown key or a bad key is refused', () => {
    /* Given */
    const h = harness({vmHosts: [{...DEV, addedAt: AGENT.installedAt}]});

    /* When */
    const renamed = h.service.rename('dev@vm.local:22', 'Dev box');
    const unknown = h.service.rename('dev@other:22', 'x');
    const bad = h.service.rename('not a key', 'x');

    /* Then */
    assert.deepEqual([renamed, unknown, bad], [true, false, false]);
    assert.equal(h.service.list()[0].label, 'Dev box');
    assert.equal(h.renderer.only('vmHostsChanged').length, 1);
});

// ── remove ──

test('removing a VM forgets it and its projects, lets go of its sessions and closes its link', () => {
    /* Given */
    const h = harness({
        vmHosts: [{...DEV, addedAt: AGENT.installedAt, agent: AGENT}],
        remoteProjects: [
            {...DEV, dir: '~/projects/site'},
            {...DEV, dir: null},
            {user: 'other', host: 'box', port: 22, dir: 'x'},
        ],
    });
    const siteSignals = h.vmSession('s1', SITE);
    const homeSignals = h.vmSession('s2', HOME);

    /* When */
    const result = h.service.remove('dev@vm.local:22');

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(h.settings.vmHosts(), []);
    assert.deepEqual(
        h.settings.remoteProjects().map((r) => r.host),
        ['box'],
    );
    assert.deepEqual([...siteSignals, ...homeSignals], [], 'no session on the VM was signalled');
    assert.deepEqual(h.terminals.signals, []);
    assert.deepEqual(h.released.sort(), ['s1', 's2']);
    assert.equal(h.registry.size, 0, 'retired here');
    assert.deepEqual(h.disconnected, ['dev@vm.local:22']);
    assert.equal(h.renderer.only('vmHostsChanged').length, 1);
    assert.ok(h.renderer.only('projectsChanged').length >= 1);
});

test('removing a VM that is not registered, or by a bad key, is refused and forgets nothing', () => {
    /* Given */
    const h = harness({remoteProjects: [{...DEV, dir: 'site'}], vmHosts: []});

    /* When */
    const unknown = h.service.remove('dev@vm.local:22');
    const bad = h.service.remove('vm.local');

    /* Then */
    assert.equal(unknown.ok, false);
    assert.equal(bad.ok, false);
    assert.equal(h.settings.remoteProjects().length, 1);
    assert.deepEqual(h.disconnected, []);
});

// ── forgetting one remote project ──

test("forgetting a VM project retires its sessions here and never signals them; an agentless remote's are stopped", () => {
    /* Given */
    const h = harness({
        vmHosts: [{...DEV, addedAt: AGENT.installedAt, agent: AGENT}],
        remoteProjects: [
            {...DEV, dir: '~/projects/site'},
            {user: 'other', host: 'box', port: 22, dir: 'x'},
        ],
    });
    const signals = h.vmSession('vm-1', SITE);
    h.localSession('box-1', 'ssh://other@box/x');
    const forget = (path: string) =>
        forgetRemoteProject(
            {
                settings: h.settings,
                registry: h.registry,
                remote: noRemote,
                lifecycle: new SessionLifecycle({
                    registry: h.registry,
                    terminals: h.terminals,
                    renderer: h.renderer,
                    remote: noRemote,
                    timers: fakeTimers(),
                    log: silentLog,
                }),
                renderer: h.renderer,
                agents: {release: (pty) => void h.released.push(pty.sessionId)},
            },
            path,
        );

    /* When */
    forget(SITE);
    forget('ssh://other@box/x');

    /* Then */
    assert.deepEqual(signals, []);
    assert.deepEqual(h.released, ['vm-1']);
    assert.equal(h.registry.find('vm-1'), null);
    assert.deepEqual(
        h.terminals.signals.map(([, signal]) => signal),
        ['SIGTERM'],
        'the agentless session is stopped as before',
    );
    assert.deepEqual(h.settings.remoteProjects(), []);
});
