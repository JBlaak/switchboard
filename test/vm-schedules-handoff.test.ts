import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import {ProjectHandoffService} from '../src/application/services/project-handoff-service';
import {SettingsService} from '../src/application/services/settings-service';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent} from './support/scripted-agent';
import type {HandoffGit} from '../src/application/ports/handoff-git';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {HandoffChoices} from '../src/application/services/project-handoff';
import type {RemoteConfig} from '../src/domain/project/remote-target';

/**
 * The hand-off's hook for where the schedules run (#276 stage 5): called once
 * the copy is made, with what the dialog chose, and never failing the
 * hand-off it follows.
 */

const LOCAL = '/Users/joris/Development/site';
const AGENT = {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'};
const COPY = 'ssh://dev@vm.local/~/projects/site';

class MemoryStore implements SettingsStore {
    private readonly values = new Map<string, unknown>();
    public get<T>(key: string): T | null {
        return (this.values.get(key) as T) ?? null;
    }
    public set(key: string, value: unknown): void {
        this.values.set(key, structuredClone(value));
    }
    public delete(key: string): void {
        this.values.delete(key);
    }
}

/** A clean repository on `main`, nothing to carry: the hand-off is only the clone. */
const git: HandoffGit = {
    repositoryRoot: async (cwd) => (cwd === LOCAL ? LOCAL : null),
    commonDir: async () => `${LOCAL}/.git`,
    currentBranch: async () => 'main',
    headOid: async () => 'abc123',
    originUrl: async () => 'git@github.com:joris/site.git',
    unpushedCount: async () => 0,
    bundle: async () => null,
    patch: async () => null,
    uncommittedPaths: async () => [],
    ignoredPaths: async () => [],
    fileSizes: async () => new Map(),
    readFile: async () => null,
    fetchFromCopy: async () => ({ok: true}),
    addWorktree: async () => ({ok: true}),
};

function harness(afterHandoff: (localPath: string, copyPath: string, choices: HandoffChoices) => Promise<void>) {
    const agent = scriptedAgent();
    const dialer = {
        dial: async (host: RemoteConfig) => {
            const link = await agent.dialer.dial(host);
            const pair = agent.current();
            pair.agent.onMessage((message) => {
                if (message.type !== 'handoff') return;
                pair.agent.send({type: 'handoff-done', requestId: message.requestId, ok: true, dir: '~/projects/site'});
            });
            return link;
        },
    };
    let connection: AgentConnection | null = null;
    const settings = new SettingsService(new MemoryStore());
    settings.addRemoteProject({user: 'dev', host: 'vm.local', port: 22, dir: null, agent: AGENT});
    const service = new ProjectHandoffService({
        agents: {
            connection: (host) =>
                (connection ??= new AgentConnection({
                    host,
                    dialer,
                    appVersion: '2.12.0',
                    timers: fakeTimers(),
                    clock: {now: () => 0},
                    log: silentLog,
                })),
        },
        git,
        settings,
        renderer: fakeRenderer(),
        forgetRemoteProject: () => {},
        timers: fakeTimers(),
        log: silentLog,
        afterHandoff,
    });
    return {service, settings};
}

test('after a hand-off the hook gets the new copy and the dialog’s choice', async () => {
    /* Given */
    const calls: [string, string, HandoffChoices][] = [];
    const h = harness(async (localPath, copyPath, choices) => void calls.push([localPath, copyPath, choices]));

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', [], undefined, {schedulesOnVm: true});

    /* Then */
    assert.deepEqual(result, {ok: true, copyPath: COPY, reused: false});
    assert.deepEqual(calls, [[LOCAL, COPY, {schedulesOnVm: true}]]);
});

test('a hook that fails leaves the hand-off done', async () => {
    /* Given */
    const h = harness(async () => {
        throw new Error('the VM went away');
    });

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', [], undefined, {schedulesOnVm: true});

    /* Then */
    assert.equal(result.ok, true);
    assert.equal(h.settings.findRemoteProject(COPY)?.copyOf, LOCAL);
});
