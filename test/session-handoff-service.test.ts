import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import {ProjectHandoffService} from '../src/application/services/project-handoff-service';
import {SessionHandoffService} from '../src/application/services/session-handoff-service';
import type {HandoffSessionView, TranscriptCarrier} from '../src/application/services/session-handoff-service';
import {SettingsService} from '../src/application/services/settings-service';
import {addRemotesRegisteringVms} from './support/vm-registry';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent, settle} from './support/scripted-agent';
import type {Disposable} from '../src/application/ports/git-workspace';
import type {HandoffGit} from '../src/application/ports/handoff-git';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {TranscriptLocation} from '../src/application/ports/transcript-store';
import type {OpenSessionRequest, OpenSessionResult} from '../src/application/services/session-launcher';
import type {SessionHandoffPhase} from '../src/application/services/session-handoff';
import type {AgentMessage, MacMessage} from '../src/domain/agent/protocol';
import type {RemoteConfig} from '../src/domain/project/remote-target';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

/**
 * The Mac's SessionHandoff (#276 stage 3), with the real project hand-off
 * driven over an in-memory agent link whose end is scripted, and fakes for
 * the registry, the prompter, the stop and the launcher. Each test checks
 * what the agent was sent, what main did to the local session and the
 * settings, and in which order.
 */

const LOCAL = '/Users/joris/Development/site';
const WORKTREE = `${LOCAL}/.claude/worktrees/fix-login`;
const FOLDER = '-Users-joris-Development-site';
const WORKTREE_FOLDER = '-Users-joris-Development-site--claude-worktrees-fix-login';
const HOST = 'dev@vm.local:22';
const AGENT = {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'};
const VM_HOME: RemoteProjectSetting = {user: 'dev', host: 'vm.local', port: 22, dir: null, agent: AGENT};
const COPY = 'ssh://dev@vm.local/~/projects/site';
const WORKTREE_COPY = 'ssh://dev@vm.local/~/projects/site/.claude/worktrees/fix-login';
const NOW = Date.parse('2026-11-03T12:00:00.000Z');

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

function artifact(text: string) {
    const bytes = Buffer.from(text);
    return {bytes, sha256: createHash('sha256').update(bytes).digest('hex')};
}

/** A repository at LOCAL with a Claude worktree, both clean but for one unpushed commit. */
function fakeGit(localBranch: string | null = 'main'): HandoffGit {
    const tops: Record<string, string> = {[LOCAL]: LOCAL, [WORKTREE]: WORKTREE, [`${WORKTREE}/src`]: WORKTREE};
    return {
        repositoryRoot: async (cwd) => tops[cwd] ?? null,
        commonDir: async (cwd) => (tops[cwd] ? `${LOCAL}/.git` : null),
        currentBranch: async (root) => (root === WORKTREE ? 'fix-login' : localBranch),
        headOid: async (root) => (root === WORKTREE ? 'wt999' : 'abc123'),
        originUrl: async () => 'git@github.com:joris/site.git',
        unpushedCount: async () => 1,
        bundle: async () => artifact('BUNDLE'),
        patch: async () => null,
        uncommittedPaths: async () => [],
        ignoredPaths: async () => ['.env'],
        fileSizes: async (_root, paths) => new Map(paths.map((p) => [p, 9])),
        readFile: async () => ({bytes: Buffer.from('SECRET=1\n'), mode: 0o600}),
        fetchFromCopy: async () => ({ok: true}),
        addWorktree: async () => ({ok: true}),
        applyPatch: async () => ({ok: true}),
    };
}

/** A running session as the registry holds it. */
function liveSession(over: Partial<HandoffSessionView> = {}): HandoffSessionView {
    return {
        pty: {pid: 1} as HandoffSessionView['pty'],
        projectPath: LOCAL,
        projectFolder: FOLDER,
        isPlainTerminal: false,
        exited: false,
        remote: null,
        ...over,
    };
}

/** A transcript written from `cwd`, three lines. */
function transcriptFrom(cwd: string): string {
    return [
        `{"type":"user","cwd":"${cwd}","sessionId":"s1","message":{"role":"user","content":"fix ${cwd}/a.ts"}}`,
        `{"type":"assistant","cwd":"${cwd}","sessionId":"s1","message":{"role":"assistant","content":"done"}}`,
        `{"type":"summary","summary":"Fix it"}`,
        '',
    ].join('\n');
}

interface HarnessOptions {
    /** The session in the registry; null for an ended one known from the index only. */
    live?: HandoffSessionView | null;
    busy?: boolean;
    cwd?: string;
    folder?: string;
    /** False for a transcript written only on a detached HEAD, which names no location. */
    located?: boolean;
    /** The branch LOCAL's checkout is on now; null for a detached HEAD. */
    localBranch?: string | null;
}

function harness({
    live = liveSession(),
    busy = false,
    cwd = LOCAL,
    folder = FOLDER,
    located = true,
    localBranch = 'main',
}: HarnessOptions = {}) {
    const order: string[] = [];
    const agent = scriptedAgent();
    const script = {
        handoffDone: {ok: true, dir: '~/projects/site', reused: false} as {
            ok: boolean;
            error?: string;
            dir?: string;
            reused?: boolean;
        },
        imported: {ok: true} as {ok: boolean; error?: string},
        opened: {ok: true} as OpenSessionResult,
        uploads: new Map<string, Buffer[]>(),
    };

    const answer = (message: MacMessage): AgentMessage[] => {
        switch (message.type) {
            case 'upload-begin':
                script.uploads.set(message.uploadId, []);
                return [];
            case 'upload-chunk':
                script.uploads.get(message.uploadId)?.push(Buffer.from(message.dataBase64, 'base64'));
                return [];
            case 'upload-end':
                return [{type: 'done', requestId: message.requestId, ok: true}];
            case 'handoff':
                order.push('handoff');
                return [
                    {type: 'handoff-progress', requestId: message.requestId, line: 'Cloning joris/site'},
                    {type: 'handoff-done', requestId: message.requestId, ...script.handoffDone},
                ];
            default:
                return [];
        }
    };
    const dialer = {
        dial: async (host: RemoteConfig) => {
            const link = await agent.dialer.dial(host);
            const pair = agent.current();
            pair.agent.onMessage((message) => answer(message).forEach((reply) => pair.agent.send(reply)));
            return link;
        },
    };
    const connections = new Map<string, AgentConnection>();
    const connectionFor = (host: RemoteConfig): AgentConnection => {
        const key = `${host.user}@${host.host}:${host.port}`;
        let connection = connections.get(key);
        if (!connection) {
            connection = new AgentConnection({
                host,
                dialer,
                appVersion: '2.12.0',
                timers: fakeTimers(),
                clock: {now: () => NOW},
                log: silentLog,
            });
            connections.set(key, connection);
        }
        return connection;
    };
    /**
     * `importTranscript` is another agent's addition to AgentConnection; here
     * it puts the message on the wire, as that one will, and answers from the
     * script.
     */
    const carrier = (host: RemoteConfig): TranscriptCarrier => {
        const connection = connectionFor(host);
        return {
            whenConnected: () => connection.whenConnected(),
            upload: (bytes, options) => connection.upload(bytes, options),
            importTranscript: async (sessionId, dir, uploadId) => {
                order.push('import');
                connection.send({type: 'import-transcript', requestId: 'import-1', sessionId, dir, uploadId});
                return script.imported;
            },
        };
    };

    const store = new MemoryStore();
    const real = new SettingsService(store);
    addRemotesRegisteringVms(real, [VM_HOME]);
    const settings = {
        effective: (projectPath: string | null | undefined) => real.effective(projectPath),
        handedOffSession: (sessionId: string) => real.handedOffSession(sessionId),
        recordHandedOffSession: (sessionId: string, copyPath: string, at: string) => {
            order.push('record');
            real.recordHandedOffSession(sessionId, copyPath, at);
        },
        touchRemoteSession: (projectPath: string, sessionId: string, kind: string, nowIso: string) => {
            order.push('touch');
            return real.touchRemoteSession(projectPath, sessionId, kind, nowIso);
        },
    };

    const git = fakeGit(localBranch);
    const projects = new ProjectHandoffService({
        agents: {connection: connectionFor},
        git,
        settings: real,
        renderer: fakeRenderer(),
        forgetRemoteProject: () => {},
        timers: fakeTimers(),
        log: silentLog,
    });

    // The running session, and the prompter's view of it.
    const registry = new Map<string, HandoffSessionView>();
    if (live) registry.set('s1', live);
    const state = {busy};
    const idle = new Set<() => void>();
    const exits = new Set<() => void>();
    const subscribe = (set: Set<() => void>, fn: () => void): Disposable => {
        set.add(fn);
        return {dispose: () => void set.delete(fn)};
    };
    const prompter = {
        runningId: (id: string) => (registry.has(id) ? id : null),
        isBusy: (id: string) => !registry.has(id) || state.busy,
        onIdle: (_id: string, fn: () => void) => subscribe(idle, fn),
        onExit: (_id: string, fn: () => void) => subscribe(exits, fn),
    };
    const goIdle = () => {
        state.busy = false;
        [...idle].forEach((fn) => fn());
    };
    const exit = () => {
        registry.delete('s1');
        [...exits].forEach((fn) => fn());
    };

    const opened: OpenSessionRequest[] = [];
    const renderer = fakeRenderer();
    const locations: TranscriptLocation[] = located ? [{cwd, branch: 'main', fromSubagent: false}] : [];
    const service = new SessionHandoffService({
        registry: {
            find: (id) => {
                const session = registry.get(id);
                return session ? {key: id, session} : null;
            },
        },
        sessions: {getCachedSession: (id) => (id === 's1' ? {folder, projectPath: LOCAL} : null)},
        transcripts: {
            locations: (f, id) => (f === folder && id === 's1' ? locations : []),
            readTail: (f, id) => (f === folder && id === 's1' ? transcriptFrom(cwd) : ''),
        },
        git,
        projects,
        agents: {connection: carrier},
        prompter,
        stop: () => {
            order.push('stop');
            // The process ends a moment after it is signalled, as a real one does.
            setImmediate(exit);
            return {ok: true};
        },
        launcher: {
            open: async (request) => {
                order.push('open');
                opened.push(request);
                return script.opened;
            },
        },
        settings,
        renderer: {
            sessionStarted: (sessionId, projectPath) => {
                order.push('sessionStarted');
                renderer.sessionStarted(sessionId, projectPath);
            },
        },
        sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
        clock: {now: () => NOW},
        timers: fakeTimers(),
        log: silentLog,
    });

    /** The transcript the VM got, put back together from its upload. */
    const importedTranscript = (): string => {
        const [message] = agent.sent('import-transcript');
        return Buffer.concat(script.uploads.get(message?.uploadId ?? '') ?? []).toString('utf8');
    };

    return {service, agent, script, order, opened, renderer, real, registry, goIdle, importedTranscript};
}

function phases() {
    const seen: SessionHandoffPhase[] = [];
    return {seen, onPhase: (phase: SessionHandoffPhase) => seen.push(phase)};
}

// ── Preview ──

test('a preview of an idle session gives its checkout, counts and candidates', async () => {
    /* Given */
    const h = harness();

    /* When */
    const preview = await h.service.preview('s1');

    /* Then */
    assert.deepEqual(preview, {
        localPath: LOCAL,
        worktree: null,
        branch: 'main',
        unpushed: 1,
        uncommitted: 0,
        candidates: [{path: '.env', size: 9, ticked: true}],
        busy: false,
    });
});

test('a session written on a detached HEAD previews once its checkout is on a branch', async () => {
    /* Given */
    const h = harness({located: false});

    /* When */
    const preview = await h.service.preview('s1');

    /* Then */
    assert.ok(!('error' in preview));
    assert.equal(preview.localPath, LOCAL);
    assert.equal(preview.branch, 'main');
});

test('a session whose checkout is still on a detached HEAD is told to check out a branch', async () => {
    /* Given */
    const h = harness({located: false, localBranch: null});

    /* When */
    const preview = await h.service.preview('s1');

    /* Then */
    assert.deepEqual(preview, {error: 'This repository is on a detached HEAD; check out a branch first.'});
});

test('a preview of a busy session in a worktree names the worktree and says it would wait', async () => {
    /* Given */
    const h = harness({
        busy: true,
        cwd: `${WORKTREE}/src`,
        folder: WORKTREE_FOLDER,
        live: liveSession({projectFolder: WORKTREE_FOLDER}),
    });

    /* When */
    const preview = await h.service.preview('s1');

    /* Then */
    assert.ok(!('error' in preview));
    assert.equal(preview.worktree, 'fix-login');
    assert.equal(preview.branch, 'fix-login');
    assert.equal(preview.busy, true);
});

test('a preview refuses a terminal, a remote session and one handed off already', async () => {
    /* Given */
    const terminal = harness({live: liveSession({isPlainTerminal: true})});
    const remote = harness({live: liveSession({projectPath: 'ssh://pi@pi.local/~/site', remote: {}})});
    const handed = harness();
    handed.real.recordHandedOffSession('s1', COPY, '2026-11-02T00:00:00.000Z');

    /* When */
    const answers = await Promise.all([
        terminal.service.preview('s1'),
        remote.service.preview('s1'),
        handed.service.preview('s1'),
    ]);

    /* Then */
    assert.deepEqual(answers, [
        {error: 'A terminal has no conversation to hand off.'},
        {error: 'This session already runs on another machine.'},
        {error: 'This session has been handed off to a VM already.'},
    ]);
});

test('an ended session is previewed from its transcript, never busy', async () => {
    /* Given */
    const h = harness({live: null});

    /* When */
    const preview = await h.service.preview('s1');

    /* Then */
    assert.ok(!('error' in preview));
    assert.equal(preview.busy, false);
    assert.equal(preview.localPath, LOCAL);
});

// ── Hand-off ──

test('an idle session is handed off, imported, stopped, recorded, touched, resumed and shown, in that order', async () => {
    /* Given */
    const h = harness();
    const {seen, onPhase} = phases();

    /* When */
    const result = await h.service.handOff('s1', HOST, ['.env'], onPhase);

    /* Then */
    assert.deepEqual(result, {kind: 'done', copyPath: COPY});
    assert.deepEqual(h.order, ['handoff', 'import', 'stop', 'record', 'touch', 'open', 'sessionStarted']);
    assert.ok(!seen.some((phase) => phase.kind === 'waiting'));
    assert.ok(seen.some((phase) => phase.kind === 'running' && phase.line === 'Cloning joris/site'));
    assert.deepEqual(seen[seen.length - 1], {kind: 'done', copyPath: COPY});
    const [imported] = h.agent.sent('import-transcript');
    assert.equal(imported.sessionId, 's1');
    assert.equal(imported.dir, '~/projects/site');
    assert.deepEqual(h.real.handedOffSession('s1'), {copyPath: COPY, at: '2026-11-03T12:00:00.000Z'});
    assert.deepEqual(h.opened, [
        {sessionId: 's1', projectPath: COPY, isNew: false, options: {type: 'remote', remoteKind: 'claude'}},
    ]);
    assert.deepEqual(h.renderer.only('sessionStarted'), [['sessionStarted', 's1', COPY]]);
    assert.ok(h.real.findRemoteProject(COPY)?.sessions?.some((record) => record.sessionId === 's1'));
});

test('the VM gets the transcript with only its cwd fields moved to the copy', async () => {
    /* Given */
    const h = harness();

    /* When */
    await h.service.handOff('s1', HOST, []);

    /* Then */
    assert.equal(
        h.importedTranscript(),
        transcriptFrom(LOCAL).replaceAll(`"cwd":"${LOCAL}"`, '"cwd":"~/projects/site"'),
    );
});

test('a busy session waits for its turn to end, then goes', async () => {
    /* Given */
    const h = harness({busy: true});
    const {seen, onPhase} = phases();
    const handing = h.service.handOff('s1', HOST, [], onPhase);
    await settle();

    /* When */
    const waited = [...seen];
    const handedBeforeIdle = [...h.order];
    h.goIdle();
    const result = await handing;

    /* Then */
    assert.deepEqual(waited, [{kind: 'waiting'}]);
    assert.deepEqual(handedBeforeIdle, []);
    assert.deepEqual(result, {kind: 'done', copyPath: COPY});
    assert.deepEqual(h.order, ['handoff', 'import', 'stop', 'record', 'touch', 'open', 'sessionStarted']);
});

test('cancelling while it waits resolves cancelled and changes nothing', async () => {
    /* Given */
    const h = harness({busy: true});
    const handing = h.service.handOff('s1', HOST, []);
    await settle();

    /* When */
    const cancelled = h.service.cancel('s1');
    const result = await handing;

    /* Then */
    assert.equal(cancelled, true);
    assert.deepEqual(result, {kind: 'cancelled'});
    assert.deepEqual(h.order, []);
    assert.equal(h.agent.sentByMac().length, 0);
    assert.ok(h.registry.has('s1'));
    assert.equal(h.real.handedOffSession('s1'), null);
    assert.equal(h.service.cancel('s1'), false);
});

test('a second hand-off of the same session while one is in flight is refused', async () => {
    /* Given */
    const h = harness({busy: true});
    const first = h.service.handOff('s1', HOST, []);
    await settle();

    /* When */
    const second = await h.service.handOff('s1', HOST, []);

    /* Then */
    assert.deepEqual(second, {kind: 'failed', error: 'This session is already being handed off.'});
    h.service.cancel('s1');
    assert.deepEqual(await first, {kind: 'cancelled'});
});

test('a failed project hand-off leaves the local session running and nothing recorded', async () => {
    /* Given */
    const h = harness();
    h.script.handoffDone = {ok: false, error: 'Cloning joris/site failed: repository not found'};

    /* When */
    const result = await h.service.handOff('s1', HOST, []);

    /* Then */
    assert.deepEqual(result, {kind: 'failed', error: 'Cloning joris/site failed: repository not found'});
    assert.deepEqual(h.order, ['handoff']);
    assert.ok(h.registry.has('s1'));
    assert.equal(h.real.handedOffSession('s1'), null);
    assert.equal(h.opened.length, 0);
});

test('a refused transcript import leaves the local session running and nothing recorded', async () => {
    /* Given */
    const h = harness();
    h.script.imported = {ok: false, error: 'a transcript of s1 is already there'};

    /* When */
    const result = await h.service.handOff('s1', HOST, []);

    /* Then */
    assert.deepEqual(result, {
        kind: 'failed',
        error: 'The VM did not take the conversation: a transcript of s1 is already there',
    });
    assert.deepEqual(h.order, ['handoff', 'import']);
    assert.ok(h.registry.has('s1'));
    assert.equal(h.real.handedOffSession('s1'), null);
});

test('a resume that fails after the stop is reported, and the row stays with the VM', async () => {
    /* Given */
    const h = harness();
    h.script.opened = {ok: false, error: 'claude is not installed on the VM'};

    /* When */
    const result = await h.service.handOff('s1', HOST, []);

    /* Then */
    assert.equal(result.kind, 'failed');
    assert.match(
        (result as {error: string}).error,
        /stopped on this Mac .* did not resume there: claude is not installed on the VM\. .*Resume tries again/,
    );
    assert.deepEqual(h.order, ['handoff', 'import', 'stop', 'record', 'touch', 'open']);
    assert.equal(h.registry.has('s1'), false);
    assert.deepEqual(h.real.handedOffSession('s1'), {copyPath: COPY, at: '2026-11-03T12:00:00.000Z'});
    assert.deepEqual(h.renderer.only('sessionStarted'), []);
});

test("a session in a worktree sends the worktree's name and resumes in the VM's worktree", async () => {
    /* Given */
    const h = harness({
        cwd: WORKTREE,
        folder: WORKTREE_FOLDER,
        live: liveSession({projectFolder: WORKTREE_FOLDER}),
    });
    h.script.handoffDone = {ok: true, dir: '~/projects/site/.claude/worktrees/fix-login'};

    /* When */
    const result = await h.service.handOff('s1', HOST, []);

    /* Then */
    assert.deepEqual(result, {kind: 'done', copyPath: WORKTREE_COPY});
    const [handoff] = h.agent.sent('handoff');
    assert.equal(handoff.worktree, 'fix-login');
    assert.equal(handoff.branch, 'fix-login');
    assert.equal(handoff.repo.name, 'site');
    const [imported] = h.agent.sent('import-transcript');
    assert.equal(imported.dir, '~/projects/site/.claude/worktrees/fix-login');
    assert.match(h.importedTranscript(), /"cwd":"~\/projects\/site\/\.claude\/worktrees\/fix-login"/);
    assert.equal(h.opened[0].projectPath, WORKTREE_COPY);
});

test('a session that entered a worktree is found in the folder its transcript moved to', async () => {
    /* Given: launched in the project, so its own folder is the project's, but
       Claude moved the transcript to the worktree's folder, where the index found it */
    const h = harness({
        cwd: WORKTREE,
        folder: WORKTREE_FOLDER,
        live: liveSession({projectFolder: FOLDER}),
    });
    h.script.handoffDone = {ok: true, dir: '~/projects/site/.claude/worktrees/fix-login'};

    /* When */
    const preview = await h.service.preview('s1');
    const result = await h.service.handOff('s1', HOST, []);

    /* Then */
    assert.ok(!('error' in preview));
    assert.equal(preview.worktree, 'fix-login');
    assert.deepEqual(result, {kind: 'done', copyPath: WORKTREE_COPY});
    assert.match(h.importedTranscript(), /"cwd":"~\/projects\/site\/\.claude\/worktrees\/fix-login"/);
});

test('an ended session is handed off without a stop', async () => {
    /* Given */
    const h = harness({live: null});

    /* When */
    const result = await h.service.handOff('s1', HOST, []);

    /* Then */
    assert.deepEqual(result, {kind: 'done', copyPath: COPY});
    assert.deepEqual(h.order, ['handoff', 'import', 'record', 'touch', 'open', 'sessionStarted']);
});
