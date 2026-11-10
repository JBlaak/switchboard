import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SessionBringBackService} from '../src/application/services/session-bring-back-service';
import type {BringBackLink} from '../src/application/services/session-bring-back-service';
import type {HandoffSessionView} from '../src/application/services/session-handoff-service';
import {SettingsService} from '../src/application/services/settings-service';
import {addRemotesRegisteringVms} from './support/vm-registry';
import {fakeTimers, silentLog} from './support/fakes';
import type {Disposable} from '../src/application/ports/git-workspace';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {OpenSessionRequest, OpenSessionResult} from '../src/application/services/session-launcher';
import type {SessionBringBackPhase} from '../src/application/services/session-bring-back';
import type {AgentSessionInfo} from '../src/domain/agent/protocol';
import type {WorktreeSummary} from '../src/domain/project/overview';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

/**
 * The Mac's SessionBringBack (#276), the counterpart of a session's hand-off,
 * with the real settings and fakes for the agent link, git, the registry, the
 * prompter, the stop and the launcher. Each test checks what was done on the
 * Mac and the VM, and in which order.
 */

const LOCAL = '/Users/joris/Development/site';
const LOCAL_WORKTREE = `${LOCAL}/.claude/worktrees/fix-login`;
const HOME = '/home/dev';
const COPY_DIR = `${HOME}/projects/site`;
const VM_WORKTREE = `${COPY_DIR}/.claude/worktrees/fix-login`;
const COPY = 'ssh://dev@vm.local/~/projects/site';
const AGENT = {version: '2.17.0', installedAt: '2026-11-01T00:00:00.000Z'};
const NOW = Date.parse('2026-11-10T12:00:00.000Z');

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

/** The VM transcript: one line carried over by the hand-off (`~` form), one written on the VM. */
const VM_TRANSCRIPT = [
    `{"type":"user","cwd":"~/projects/site/.claude/worktrees/fix-login","sessionId":"s1","message":"fix it"}`,
    `{"type":"assistant","cwd":"${VM_WORKTREE}","sessionId":"s1","message":"done"}`,
    '',
].join('\n');

interface HarnessOptions {
    /** The session is attached here (in the registry); false when it only runs on the agent, or not at all. */
    attached?: boolean;
    /** The agent runs it. */
    alive?: boolean;
    busy?: boolean;
    /** The checkout the session works in on the VM. */
    cwd?: string;
    vmBranch?: string | null;
    uncommitted?: string[];
    /** The local repository's worktrees; the branch is "here" when one has it, or `branchHere`. */
    worktrees?: WorktreeSummary[];
    branchHere?: boolean;
    /** The copy names no local project. */
    notACopy?: boolean;
    /** The folder an older local transcript of the session is indexed in. */
    olderFolder?: string | null;
    addWorktree?: {ok: true} | {ok: false; reason: string; taken: boolean};
}

function worktree(path: string, over: Partial<WorktreeSummary> = {}): WorktreeSummary {
    return {
        path,
        branch: 'fix-login',
        main: false,
        locked: false,
        changedFiles: 0,
        ahead: 2,
        merged: false,
        lastCommitAt: null,
        ...over,
    };
}

function harness({
    attached = true,
    alive = true,
    busy = false,
    cwd = VM_WORKTREE,
    vmBranch = 'fix-login',
    uncommitted = [],
    worktrees = [worktree(LOCAL, {branch: 'main', main: true, ahead: 0})],
    branchHere = false,
    notACopy = false,
    olderFolder = null,
    addWorktree = {ok: true},
}: HarnessOptions = {}) {
    const order: string[] = [];

    const real = new SettingsService(new MemoryStore());
    const copy: RemoteProjectSetting = {
        user: 'dev',
        host: 'vm.local',
        port: 22,
        dir: '~/projects/site',
        agent: AGENT,
        ...(notACopy ? {} : {copyOf: LOCAL}),
    };
    addRemotesRegisteringVms(real, [copy]);
    real.touchRemoteSession(COPY, 's1', 'claude', '2026-11-09T10:00:00.000Z');
    real.recordHandedOffSession('s1', COPY, '2026-11-09T10:00:00.000Z');

    // The session, as the registry and the prompter see it.
    const registry = new Map<string, HandoffSessionView>();
    const attach = () =>
        registry.set('s1', {
            pty: {pid: 1} as HandoffSessionView['pty'],
            projectPath: COPY,
            projectFolder: null,
            isPlainTerminal: false,
            exited: false,
            remote: null,
        });
    if (attached && alive) attach();
    const state = {busy, alive};
    const idle = new Set<() => void>();
    const exits = new Set<() => void>();
    const subscribe = (set: Set<() => void>, fn: () => void): Disposable => {
        set.add(fn);
        return {dispose: () => void set.delete(fn)};
    };
    const prompter = {
        runningId: (id: string) => (registry.has(id) ? id : null),
        isBusy: (id: string) => registry.has(id) && state.busy,
        onIdle: (_id: string, fn: () => void) => subscribe(idle, fn),
        onExit: (_id: string, fn: () => void) => subscribe(exits, fn),
    };
    const goIdle = () => {
        state.busy = false;
        [...idle].forEach((fn) => fn());
    };

    const link: BringBackLink = {
        home: HOME,
        whenConnected: async () => {},
        listSessions: async (): Promise<AgentSessionInfo[]> =>
            state.alive ? [{sessionId: 's1', kind: 'claude', cwd, alive: true, lastSeq: 3}] : [],
        getTranscript: async () => ({cwd}),
        copyStatus: async (dir) => {
            order.push(`copy-status ${dir}`);
            return {ok: true, branch: vmBranch, uncommitted};
        },
        readTranscript: async () => {
            order.push('read-transcript');
            return Buffer.from(VM_TRANSCRIPT);
        },
    };

    const written: {projectPath: string; sessionId: string; text: string}[] = [];
    const opened: OpenSessionRequest[] = [];
    const script = {opened: {ok: true} as OpenSessionResult};
    const hasBranch = branchHere || worktrees.some((w) => w.branch === 'fix-login');

    const service = new SessionBringBackService({
        registry: {
            find: (id) => {
                const session = registry.get(id);
                return session ? {key: id, session} : null;
            },
        },
        sessions: {getCachedSession: (id) => (id === 's1' && olderFolder ? {folder: olderFolder} : null)},
        transcripts: {
            writeSession: (projectPath, sessionId, text) => {
                order.push('write-transcript');
                written.push({projectPath, sessionId, text});
                return '-Users-joris-Development-site--claude-worktrees-fix-login';
            },
            setSessionAside: (folder) => order.push(`set-aside ${folder}`),
        },
        handoffGit: {
            repositoryRoot: async (path) => (path === LOCAL ? LOCAL : null),
            fetchFromCopy: async (_root, remote, url, branch) => {
                order.push(`fetch ${remote} ${url} ${branch}`);
                return {ok: true};
            },
            addWorktree: async (_root, path, branch, base) => {
                order.push(`add-worktree ${path} ${branch} ${base}`);
                return addWorktree;
            },
        },
        git: {
            branchExists: async (_root, branch) => branch === 'fix-login' && hasBranch,
            worktrees: async () => worktrees,
            removeWorktree: async (_root, path) => {
                order.push(`remove-worktree ${path}`);
                return {ok: true};
            },
            pruneWorktrees: async () => {
                order.push('prune');
                return {ok: true};
            },
            deleteBranch: async (_root, branch) => {
                order.push(`delete-branch ${branch}`);
                return {ok: true};
            },
        },
        agents: {connection: () => link},
        prompter,
        stop: () => {
            order.push('stop');
            // The process ends a moment after it is signalled, as a real one does.
            setImmediate(() => {
                registry.delete('s1');
                state.alive = false;
                [...exits].forEach((fn) => fn());
            });
            return {ok: true};
        },
        launcher: {
            open: async (request) => {
                order.push(`open ${request.projectPath}`);
                opened.push(request);
                if (request.projectPath === COPY) attach();
                return script.opened;
            },
        },
        settings: real,
        renderer: {
            sessionStarted: (_id, projectPath) => order.push(`sessionStarted ${projectPath}`),
            projectsChanged: () => order.push('projectsChanged'),
        },
        clock: {now: () => NOW},
        timers: fakeTimers(),
        log: silentLog,
    });

    return {service, order, written, opened, real, script, goIdle};
}

function phases() {
    const seen: SessionBringBackPhase[] = [];
    return {seen, onPhase: (phase: SessionBringBackPhase) => seen.push(phase)};
}

const remoteSessionIds = (real: SettingsService) =>
    (real.findRemoteProject(COPY)?.sessions ?? []).map((record) => record.sessionId);

// ── Preview ──

test("a preview names the VM worktree's branch and the local worktree it lands in", async () => {
    /* Given */
    const h = harness();

    /* When */
    const preview = await h.service.preview('s1');

    /* Then */
    assert.deepEqual(preview, {
        copyPath: COPY,
        localPath: LOCAL,
        branch: 'fix-login',
        worktree: LOCAL_WORKTREE,
        existing: null,
        busy: false,
    });
});

test('a preview says where the branch is already, when the Mac has it', async () => {
    /* Given */
    const h = harness({worktrees: [worktree(LOCAL_WORKTREE, {changedFiles: 1})]});

    /* When */
    const preview = await h.service.preview('s1');

    /* Then */
    assert.ok(!('error' in preview));
    assert.equal(preview.worktree, LOCAL_WORKTREE);
    assert.deepEqual(preview.existing, {
        branch: 'fix-login',
        worktreePath: LOCAL_WORKTREE,
        main: false,
        changedFiles: 1,
        ahead: 2,
        sessionId: null,
    });
});

test('a session on a VM project that is not a copy cannot be brought back', async () => {
    /* Given */
    const h = harness({notACopy: true});

    /* When */
    const preview = await h.service.preview('s1');

    /* Then */
    assert.ok('error' in preview);
    assert.match(preview.error, /not a copy/);
});

test('uncommitted changes on the VM are refused, naming them', async () => {
    /* Given */
    const h = harness({uncommitted: ['src/a.ts', 'src/b.ts']});

    /* When */
    const done = await h.service.bringBack('s1');

    /* Then */
    assert.equal(done.kind, 'failed');
    assert.match(done.kind === 'failed' ? done.error : '', /src\/a\.ts, src\/b\.ts.*Commit them on the VM/);
    assert.ok(!h.order.some((step) => step.startsWith('fetch') || step === 'stop'));
});

// ── Bring back ──

test('a Bring back fetches the branch, stops the VM session, carries the conversation and resumes here', async () => {
    /* Given */
    const h = harness();
    const {seen, onPhase} = phases();

    /* When */
    const done = await h.service.bringBack('s1', undefined, onPhase);

    /* Then */
    assert.deepEqual(done, {kind: 'done', projectPath: LOCAL_WORKTREE});
    assert.deepEqual(h.order, [
        `copy-status ${VM_WORKTREE}`,
        `copy-status ${VM_WORKTREE}`,
        `fetch vm-vm.local ssh://dev@vm.local/~/projects/site fix-login`,
        `add-worktree ${LOCAL_WORKTREE} fix-login vm-vm.local/fix-login`,
        'stop',
        'read-transcript',
        'write-transcript',
        'projectsChanged',
        `open ${LOCAL_WORKTREE}`,
        `sessionStarted ${LOCAL_WORKTREE}`,
    ]);
    assert.equal(
        h.written[0].text,
        VM_TRANSCRIPT.replaceAll(`~/projects/site/.claude/worktrees/fix-login`, LOCAL_WORKTREE).replaceAll(
            VM_WORKTREE,
            LOCAL_WORKTREE,
        ),
    );
    assert.deepEqual(
        {sessionId: h.opened[0].sessionId, isNew: h.opened[0].isNew, type: h.opened[0].options?.type},
        {sessionId: 's1', isNew: false, type: undefined},
    );
    assert.deepEqual(remoteSessionIds(h.real), [], 'the VM row goes');
    assert.equal(h.real.handedOffSession('s1'), null, 'the local row shows again');
    assert.ok(seen.some((phase) => phase.kind === 'running' && phase.line === 'Carrying the conversation back'));
});

test('an older local transcript in another folder is set aside, not deleted', async () => {
    /* Given */
    const h = harness({olderFolder: '-Users-joris-Development-site'});

    /* When */
    await h.service.bringBack('s1');

    /* Then */
    assert.ok(h.order.includes('set-aside -Users-joris-Development-site'));
});

test('a session the agent runs but this Mac has not attached is attached first, then stopped', async () => {
    /* Given */
    const h = harness({attached: false});

    /* When */
    const done = await h.service.bringBack('s1');

    /* Then */
    assert.equal(done.kind, 'done');
    const opens = h.order.filter((step) => step.startsWith('open'));
    assert.deepEqual(opens, [`open ${COPY}`, `open ${LOCAL_WORKTREE}`]);
    assert.ok(h.order.indexOf('stop') < h.order.indexOf('read-transcript'));
});

test('a session that has ended on the VM is not stopped, only brought back', async () => {
    /* Given */
    const h = harness({attached: false, alive: false});

    /* When */
    const done = await h.service.bringBack('s1');

    /* Then */
    assert.equal(done.kind, 'done');
    assert.ok(!h.order.includes('stop'));
    assert.ok(!h.order.includes(`open ${COPY}`));
});

test('a session mid-turn waits for the turn to end, then goes', async () => {
    /* Given */
    const h = harness({busy: true});
    const {seen, onPhase} = phases();

    /* When */
    const going = h.service.bringBack('s1', undefined, onPhase);
    await new Promise((resolve) => setImmediate(resolve));
    const waited = seen.some((phase) => phase.kind === 'waiting');
    const stoppedEarly = h.order.includes('stop');
    h.goIdle();
    const done = await going;

    /* Then */
    assert.ok(waited);
    assert.equal(stoppedEarly, false);
    assert.equal(done.kind, 'done');
});

test('a Bring back cancelled while it waits changes nothing', async () => {
    /* Given */
    const h = harness({busy: true});

    /* When */
    const going = h.service.bringBack('s1');
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = h.service.cancel('s1');
    const done = await going;

    /* Then */
    assert.equal(cancelled, true);
    assert.deepEqual(done, {kind: 'cancelled'});
    assert.ok(!h.order.some((step) => step.startsWith('fetch') || step === 'stop'));
    assert.deepEqual(remoteSessionIds(h.real), ['s1']);
});

test('a resume that fails here says the conversation is here and Resume tries again', async () => {
    /* Given */
    const h = harness();
    h.script.opened = {ok: false, error: 'no shell'};

    /* When */
    const done = await h.service.bringBack('s1');

    /* Then */
    assert.equal(done.kind, 'failed');
    assert.match(done.kind === 'failed' ? done.error : '', /no shell.*Resume tries again/);
    assert.deepEqual(remoteSessionIds(h.real), [], 'the row is here already');
});

// ── A branch that is here already ──

test('with the branch here and no choice made, it asks, and changes nothing', async () => {
    /* Given */
    const h = harness({worktrees: [worktree(LOCAL_WORKTREE)]});

    /* When */
    const done = await h.service.bringBack('s1');

    /* Then */
    assert.equal(done.kind, 'existing');
    assert.equal(done.kind === 'existing' ? done.existing.worktreePath : null, LOCAL_WORKTREE);
    assert.ok(!h.order.some((step) => step.startsWith('fetch') || step.startsWith('add-worktree') || step === 'stop'));
    assert.deepEqual(remoteSessionIds(h.real), ['s1']);
});

test('Update it brings the VM commits into the existing worktree, wherever it is', async () => {
    /* Given */
    const elsewhere = '/Users/joris/Development/site-fix-login';
    const h = harness({worktrees: [worktree(elsewhere)]});

    /* When */
    const done = await h.service.bringBack('s1', 'reuse');

    /* Then */
    assert.deepEqual(done, {kind: 'done', projectPath: elsewhere});
    assert.ok(h.order.includes(`add-worktree ${elsewhere} fix-login vm-vm.local/fix-login`));
    assert.ok(!h.order.some((step) => step.startsWith('remove-worktree') || step.startsWith('delete-branch')));
});

test('Update it that git refuses says so and points at Delete and recreate, before stopping anything', async () => {
    /* Given */
    const h = harness({
        worktrees: [worktree(LOCAL_WORKTREE)],
        addWorktree: {ok: false, reason: 'fix-login has commits here that vm-vm.local/fix-login does not', taken: true},
    });

    /* When */
    const done = await h.service.bringBack('s1', 'reuse');

    /* Then */
    assert.equal(done.kind, 'failed');
    assert.match(done.kind === 'failed' ? done.error : '', /commits here.*Delete and recreate/);
    assert.ok(!h.order.includes('stop'));
});

test('Delete and recreate deletes the worktree and the branch, then makes them afresh from the VM', async () => {
    /* Given */
    const h = harness({worktrees: [worktree(LOCAL_WORKTREE, {changedFiles: 3})]});

    /* When */
    const done = await h.service.bringBack('s1', 'replace');

    /* Then */
    assert.deepEqual(done, {kind: 'done', projectPath: LOCAL_WORKTREE});
    const git = h.order.filter((step) => /^(remove-worktree|prune|delete-branch|add-worktree)/.test(step));
    assert.deepEqual(git, [
        `remove-worktree ${LOCAL_WORKTREE}`,
        'prune',
        'delete-branch fix-login',
        `add-worktree ${LOCAL_WORKTREE} fix-login vm-vm.local/fix-login`,
    ]);
});

test('Delete and recreate deletes a branch with no worktree too', async () => {
    /* Given */
    const h = harness({branchHere: true});

    /* When */
    const done = await h.service.bringBack('s1', 'replace');

    /* Then */
    assert.equal(done.kind, 'done');
    assert.ok(!h.order.some((step) => step.startsWith('remove-worktree')));
    assert.ok(h.order.includes('delete-branch fix-login'));
});

test('the main checkout is never deleted', async () => {
    /* Given */
    const h = harness({cwd: COPY_DIR, worktrees: [worktree(LOCAL, {main: true})]});

    /* When */
    const done = await h.service.bringBack('s1', 'replace');

    /* Then */
    assert.equal(done.kind, 'failed');
    assert.match(done.kind === 'failed' ? done.error : '', /main checkout, which is never deleted/);
    assert.ok(!h.order.some((step) => step.startsWith('delete-branch') || step === 'stop'));
});

test("a session in the copy's own checkout comes back into a worktree named for its branch", async () => {
    /* Given */
    const h = harness({cwd: COPY_DIR, vmBranch: 'feature-x'});

    /* When */
    const done = await h.service.bringBack('s1');

    /* Then */
    assert.deepEqual(done, {kind: 'done', projectPath: `${LOCAL}/.claude/worktrees/feature-x`});
    assert.ok(h.order.includes(`copy-status ${COPY_DIR}`));
});
