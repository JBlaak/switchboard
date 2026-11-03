import {test} from 'node:test';
import assert from 'node:assert/strict';

import {agentHostKey} from '../src/application/services/agent-client/agent-client';
import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import {SettingsService} from '../src/application/services/settings-service';
import {addRemotesRegisteringVms} from './support/vm-registry';
import {VmSchedulesService} from '../src/application/services/vm-schedules-service';
import {AGENT_PROTOCOL_VERSION} from '../src/domain/agent/protocol';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {HOST_SETTINGS, scriptedAgent, settle} from './support/scripted-agent';
import type {LinkPair} from './support/agent-link';
import type {DirEntry, FileSystem} from '../src/application/ports/file-system';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {AgentMessage, MacMessage} from '../src/domain/agent/protocol';
import type {RemoteConfig} from '../src/domain/project/remote-target';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

/**
 * The Mac's VmSchedules (#276 stage 5, Q18), against scripted agents over
 * in-memory links: where a project's schedules run, what each VM's
 * `scheduleDirs` holds after a move, what waits for a VM that was away, and
 * the runs a VM's schedules made becoming session records.
 */

const LOCAL = '/Users/joris/Development/site';
const AGENT = {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'};
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const COPY_A = 'ssh://dev@vm-a/~/projects/site';
const COPY_A2 = 'ssh://dev@vm-a/~/projects/site/.claude/worktrees/fix';
const COPY_B = 'ssh://dev@vm-b/~/projects/site';
const KEY_A = 'dev@vm-a:22';

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

/** A file system holding only folders of names: enough to count schedule files. */
function fakeFs(dirs: Record<string, string[]>): Pick<FileSystem, 'exists' | 'readDir' | 'join'> {
    return {
        exists: (path) => path in dirs,
        readDir: (path): DirEntry[] => (dirs[path] ?? []).map((name) => ({name, isFile: true, isDirectory: false})),
        join: (...parts) => parts.join('/'),
    };
}

/** One VM as its agent keeps it. */
interface Vm {
    reachable: boolean;
    scheduleDirs: string[];
    /** What `list-transcripts` can answer, before filtering by `dirs` and `since`. */
    sessions: {sessionId: string; dir: string; mtimeMs: number}[];
    /** Every `scheduleDirs` the Mac wrote. */
    writes: string[][];
}

function copy(copyPath: string): RemoteProjectSetting {
    const m = /^ssh:\/\/(\w+)@([\w-]+)\/(.+)$/.exec(copyPath);
    if (!m) throw new Error(copyPath);
    return {user: m[1], host: m[2], port: 22, dir: m[3], agent: AGENT, copyOf: LOCAL};
}

function harness({
    copies = [COPY_A, COPY_B],
    schedules = ['schedule-nightly.md', 'schedule-weekly.md', 'notes.md'],
}: {copies?: string[]; schedules?: string[]} = {}) {
    const vms = new Map<string, Vm>([
        ['vm-a', {reachable: true, scheduleDirs: [], sessions: [], writes: []}],
        ['vm-b', {reachable: true, scheduleDirs: [], sessions: [], writes: []}],
    ]);
    const vm = (name: string): Vm => vms.get(name) as Vm;
    const agent = scriptedAgent();
    agent.greet = 'silent';

    const answer = (state: Vm, message: MacMessage): AgentMessage | null => {
        const settings = {...HOST_SETTINGS, scheduleDirs: [...state.scheduleDirs]};
        switch (message.type) {
            case 'hello':
                return {
                    type: 'welcome',
                    protocol: AGENT_PROTOCOL_VERSION,
                    agentVersion: message.appVersion,
                    settings,
                    home: '/home/dev',
                };
            case 'get-host-settings':
                return {type: 'host-settings', requestId: message.requestId, settings};
            case 'set-host-settings':
                if (message.settings.scheduleDirs) {
                    state.scheduleDirs = [...message.settings.scheduleDirs];
                    state.writes.push([...state.scheduleDirs]);
                }
                return {
                    type: 'host-settings',
                    requestId: message.requestId,
                    settings: {...settings, scheduleDirs: [...state.scheduleDirs]},
                };
            case 'list-transcripts':
                return {
                    type: 'transcript-list',
                    requestId: message.requestId,
                    sessions: state.sessions.filter(
                        (s) =>
                            message.dirs.some((d) => s.dir.startsWith(d.replace('~', '/home/dev'))) &&
                            (message.since === undefined || s.mtimeMs > message.since),
                    ),
                };
            default:
                return null;
        }
    };
    const links = new Map<string, LinkPair>();
    const dialer = {
        dial: async (host: RemoteConfig) => {
            const state = vm(host.host);
            if (!state.reachable) agent.failNextDial = `ssh: connect to host ${host.host}: Operation timed out`;
            const link = await agent.dialer.dial(host);
            const pair = agent.current();
            links.set(host.host, pair);
            pair.agent.onMessage((message) => {
                const reply = answer(state, message);
                if (reply) pair.agent.send(reply);
            });
            return link;
        },
    };

    const connectedListeners: ((connection: AgentConnection) => void)[] = [];
    const connections = new Map<string, AgentConnection>();
    const connection = (host: RemoteConfig): AgentConnection => {
        const key = agentHostKey(host);
        let made = connections.get(key);
        if (!made) {
            made = new AgentConnection({
                host: {user: host.user, host: host.host, port: Number(host.port) || 22},
                dialer,
                appVersion: '2.12.0',
                timers: fakeTimers(),
                clock: {now: () => NOW},
                log: silentLog,
            });
            made.onConnected((c) => connectedListeners.forEach((l) => l(c)));
            connections.set(key, made);
        }
        return made;
    };

    const settings = new SettingsService(new MemoryStore());
    addRemotesRegisteringVms(
        settings,
        copies.map((copyPath) => copy(copyPath)),
    );
    const renderer = fakeRenderer();
    const timers = fakeTimers();
    const service = new VmSchedulesService({
        agents: {connection, onConnected: (listener) => void connectedListeners.push(listener)},
        settings,
        fs: fakeFs({[`${LOCAL}/.claude/commands`]: schedules}),
        renderer,
        clock: {now: () => NOW},
        timers,
        log: silentLog,
    });
    service.start();
    /** The VM goes away: its link drops and it cannot be dialled until `reconnect`. */
    const goAway = (name: string) => {
        vm(name).reachable = false;
        links.get(name)?.drop('Broken pipe');
    };
    return {service, settings, vm, connection, timers, renderer, goAway};
}

type Harness = ReturnType<typeof harness>;

/** Let a call that waits on a VM that is away give up: its reach timeout fires. */
async function timingOut<T>(h: Harness, call: Promise<T>): Promise<T> {
    await settle();
    h.timers.tick();
    return call;
}

/** Bring a VM back and let its connect run through. */
async function reconnect(h: Harness, name: string): Promise<void> {
    h.vm(name).reachable = true;
    h.connection({user: 'dev', host: name, port: 22}).retryNow();
    for (let i = 0; i < 10; i++) await settle();
}

// ── Where ──

test('a local project with schedule files runs them on the Mac until it is told otherwise', async () => {
    /* Given */
    const h = harness();

    /* When */
    const location = await h.service.where(LOCAL);

    /* Then */
    assert.deepEqual(location, {localPath: LOCAL, runsOn: {kind: 'mac'}, count: 2});
});

test('a copy answers for its local project, with the copy its schedules run in', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);

    /* When */
    const fromCopy = await h.service.where(COPY_B);

    /* Then */
    assert.deepEqual(fromCopy, {localPath: LOCAL, runsOn: {kind: 'vm', copyPath: COPY_A}, count: 2});
});

test('a project with neither schedules nor copies has nothing to show', async () => {
    /* Given */
    const h = harness({copies: [], schedules: []});

    /* When */
    const location = await h.service.where(LOCAL);

    /* Then */
    assert.equal(location, null);
});

// ── Moving ──

test('running the schedules on a VM puts the copy in that VM’s scheduleDirs and nowhere else', async () => {
    /* Given */
    const h = harness();

    /* When */
    const location = await h.service.runOn(LOCAL, COPY_A);

    /* Then */
    assert.deepEqual(location, {localPath: LOCAL, runsOn: {kind: 'vm', copyPath: COPY_A}, count: 2});
    assert.deepEqual(h.vm('vm-a').scheduleDirs, ['~/projects/site']);
    assert.deepEqual(h.vm('vm-b').writes, []);
    assert.equal(h.settings.scheduleChoice(LOCAL)?.copyPath, COPY_A);
});

test('moving them back to the Mac takes the copy off its VM’s list', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);

    /* When */
    const location = await h.service.runOn(LOCAL, null);

    /* Then */
    assert.deepEqual(location, {localPath: LOCAL, runsOn: {kind: 'mac'}, count: 2});
    assert.deepEqual(h.vm('vm-a').scheduleDirs, []);
    assert.equal(h.settings.scheduleChoice(LOCAL), null);
});

test('moving them to a copy on another VM adds it there and takes the old copy off the old VM', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);

    /* When */
    await h.service.runOn(LOCAL, COPY_B);

    /* Then */
    assert.deepEqual(h.vm('vm-b').scheduleDirs, ['~/projects/site']);
    assert.deepEqual(h.vm('vm-a').scheduleDirs, []);
    assert.equal(h.settings.scheduleChoice(LOCAL)?.copyPath, COPY_B);
});

test('moving them between two copies on one VM swaps the folders in a single write', async () => {
    /* Given */
    const h = harness({copies: [COPY_A, COPY_A2]});
    await h.service.runOn(LOCAL, COPY_A);

    /* When */
    await h.service.runOn(LOCAL, COPY_A2);

    /* Then */
    assert.deepEqual(h.vm('vm-a').writes, [['~/projects/site'], ['~/projects/site/.claude/worktrees/fix']]);
});

test('a path that is not one of the project’s copies is refused', async () => {
    /* Given */
    const h = harness({copies: [COPY_A]});

    /* When */
    const result = await h.service.runOn(LOCAL, COPY_B);

    /* Then */
    assert.ok('error' in result);
    assert.equal(h.settings.scheduleChoice(LOCAL), null);
});

// ── A VM that is away ──

test('back to the Mac with the VM away: the Mac runs them at once, the VM keeps them until it is back', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);
    h.goAway('vm-a');

    /* When */
    const location = await timingOut(h, h.service.runOn(LOCAL, null));

    /* Then */
    assert.deepEqual(location, {localPath: LOCAL, runsOn: {kind: 'mac'}, count: 2});
    assert.equal(h.service.macRunsSchedulesOf(LOCAL), true);
    assert.deepEqual(h.vm('vm-a').scheduleDirs, ['~/projects/site']);
    assert.deepEqual(h.settings.vmSchedules().pendingRemovals, {[KEY_A]: ['~/projects/site']});
});

test('a VM that was away drops the copy it no longer runs on its next connect', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);
    h.goAway('vm-a');
    await timingOut(h, h.service.runOn(LOCAL, null));

    /* When */
    await reconnect(h, 'vm-a');

    /* Then */
    assert.deepEqual(h.vm('vm-a').scheduleDirs, []);
    assert.deepEqual(h.settings.vmSchedules().pendingRemovals, {});
});

test('a move to a VM that is away fails, keeps the Mac running them, and lands when the VM connects', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);
    await h.service.runOn(LOCAL, null);
    h.goAway('vm-a');
    const failed = await timingOut(h, h.service.runOn(LOCAL, COPY_A));
    const macRanThemMeanwhile = h.service.macRunsSchedulesOf(LOCAL);

    /* When */
    await reconnect(h, 'vm-a');

    /* Then */
    assert.ok('error' in failed);
    assert.equal(macRanThemMeanwhile, true);
    assert.deepEqual(h.vm('vm-a').scheduleDirs, ['~/projects/site']);
    assert.equal(h.settings.scheduleChoice(LOCAL)?.copyPath, COPY_A);
    assert.equal(h.service.macRunsSchedulesOf(LOCAL), false);
    assert.ok(h.renderer.only('projectsChanged').length > 0);
});

test('on connect the VM’s list is brought in line with the choices, leaving folders the Mac does not know', async () => {
    /* Given */
    const h = harness({copies: [COPY_A, COPY_A2]});
    await h.service.runOn(LOCAL, COPY_A);
    h.goAway('vm-a');
    // Meanwhile the VM's list drifted: our choice gone, our other copy in, and somebody else's folder.
    h.vm('vm-a').scheduleDirs = ['~/projects/site/.claude/worktrees/fix', '~/projects/other'];

    /* When */
    await reconnect(h, 'vm-a');

    /* Then */
    assert.deepEqual([...h.vm('vm-a').scheduleDirs].sort(), ['~/projects/other', '~/projects/site']);
});

// ── The Mac's loop ──

test('the Mac skips a project, and its worktrees, whose schedules run on a VM; others it runs', async () => {
    /* Given */
    const h = harness();

    /* When */
    await h.service.runOn(LOCAL, COPY_A);

    /* Then */
    assert.equal(h.service.macRunsSchedulesOf(LOCAL), false);
    assert.equal(h.service.macRunsSchedulesOf(`${LOCAL}/.claude/worktrees/fix`), false);
    assert.equal(h.service.macRunsSchedulesOf('/Users/joris/Development/other'), true);
    assert.equal(h.service.macRunsSchedulesOf(`${LOCAL}-old`), true);
});

test('a project whose copy was removed runs its schedules on the Mac again', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);

    /* When */
    h.settings.removeRemoteProject(COPY_A);

    /* Then */
    assert.equal(h.service.macRunsSchedulesOf(LOCAL), true);
    assert.deepEqual((await h.service.where(LOCAL))?.runsOn, {kind: 'mac'});
});

// ── Runs made on the VM ──

test('runs the VM’s schedules made become session records on the copy, once each', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);
    h.settings.touchRemoteSession(COPY_A, 'opened-from-mac', 'claude', '2026-11-03T12:00:00.000Z');
    h.vm('vm-a').sessions = [
        {sessionId: 'nightly-run', dir: '/home/dev/projects/site', mtimeMs: NOW + 60_000},
        {sessionId: 'opened-from-mac', dir: '/home/dev/projects/site', mtimeMs: NOW + 30_000},
        {sessionId: 'elsewhere', dir: '/home/dev/projects/other', mtimeMs: NOW + 90_000},
    ];
    h.goAway('vm-a');

    /* When */
    await reconnect(h, 'vm-a');
    await reconnect(h, 'vm-a');

    /* Then */
    const sessions = h.settings.findRemoteProject(COPY_A)?.sessions ?? [];
    assert.deepEqual(
        sessions.map((s) => [s.sessionId, s.kind, s.created]),
        [
            ['opened-from-mac', 'claude', '2026-11-03T12:00:00.000Z'],
            ['nightly-run', 'claude', new Date(NOW + 60_000).toISOString()],
        ],
    );
    assert.equal(h.settings.vmSchedules().runsSince[KEY_A], NOW + 60_000);
    assert.equal(h.renderer.only('projectsChanged').length, 1);
});

test('while connected the VM is asked again every few minutes, from where the last ask left off', async () => {
    /* Given */
    const h = harness();
    await h.service.runOn(LOCAL, COPY_A);
    await reconnectFresh(h);
    h.vm('vm-a').sessions = [{sessionId: 'weekly-run', dir: '/home/dev/projects/site', mtimeMs: NOW + 120_000}];

    /* When */
    h.timers.tick();
    for (let i = 0; i < 5; i++) await settle();

    /* Then */
    assert.deepEqual(
        (h.settings.findRemoteProject(COPY_A)?.sessions ?? []).map((s) => s.sessionId),
        ['weekly-run'],
    );
    assert.equal(h.settings.vmSchedules().runsSince[KEY_A], NOW + 120_000);
});

/** Drop vm-a's link and let it connect again, which reads its runs once. */
async function reconnectFresh(h: Harness): Promise<void> {
    h.goAway('vm-a');
    await reconnect(h, 'vm-a');
}

// ── The hand-off ──

test('a hand-off that chose the VM moves the schedules to the new copy; one that did not leaves them', async () => {
    /* Given */
    const h = harness();

    /* When */
    await h.service.afterHandoff(LOCAL, COPY_B, {schedulesOnVm: false});
    const afterNo = h.settings.scheduleChoice(LOCAL);
    await h.service.afterHandoff(LOCAL, COPY_A, {schedulesOnVm: true});

    /* Then */
    assert.equal(afterNo, null);
    assert.equal(h.settings.scheduleChoice(LOCAL)?.copyPath, COPY_A);
    assert.deepEqual(h.vm('vm-a').scheduleDirs, ['~/projects/site']);
});
