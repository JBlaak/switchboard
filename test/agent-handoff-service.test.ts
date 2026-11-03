import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import {ProjectHandoffService} from '../src/application/services/project-handoff-service';
import {SettingsService} from '../src/application/services/settings-service';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent, settle} from './support/scripted-agent';
import type {GitWrite} from '../src/application/ports/git-workspace';
import type {BringBackWorktree, HandoffArtifact, HandoffGit} from '../src/application/ports/handoff-git';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {AgentMessage, CopyStateMessage, HandoffMessage, MacMessage} from '../src/domain/agent/protocol';
import type {RemoteConfig} from '../src/domain/project/remote-target';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

/**
 * The Mac's ProjectHandoff (#276 stage 2), driven over an in-memory agent
 * link with the agent end scripted: what went over the wire, what the
 * settings hold afterwards, and what the user was told.
 */

const LOCAL = '/Users/joris/Development/site';
const AGENT = {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'};
const VM_HOME: RemoteProjectSetting = {user: 'dev', host: 'vm.local', port: 22, dir: null, agent: AGENT};
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

function artifact(text: string): HandoffArtifact {
    const bytes = Buffer.from(text);
    return {bytes, sha256: createHash('sha256').update(bytes).digest('hex')};
}

/** A local repository with two unpushed commits, two uncommitted files and some ignored ones. */
function fakeGit(over: Partial<HandoffGit> = {}) {
    const calls: string[] = [];
    const files: Record<string, string> = {
        '.env': 'SECRET=1\n',
        '.env.local': 'LOCAL=1\n',
        'certs/dev.pem': 'PEM\n',
        'big.local': 'x'.repeat(600 * 1024),
    };
    const git: HandoffGit = {
        repositoryRoot: async (cwd) => (cwd === LOCAL ? LOCAL : null),
        commonDir: async (cwd) => (cwd === LOCAL ? `${LOCAL}/.git` : null),
        currentBranch: async () => 'feature',
        headOid: async () => 'abc123',
        originUrl: async () => 'git@github.com:joris/site.git',
        unpushedCount: async () => 2,
        bundle: async () => artifact('BUNDLE'),
        patch: async () => artifact('PATCH'),
        uncommittedPaths: async () => ['a.txt', 'new.txt'],
        ignoredPaths: async () => [...Object.keys(files), 'node_modules/', 'build/', 'notes.log'],
        fileSizes: async (_root, paths) =>
            new Map(paths.filter((p) => p in files).map((p) => [p, Buffer.byteLength(files[p])])),
        readFile: async (_root, p) => (p in files ? {bytes: Buffer.from(files[p]), mode: 0o600} : null),
        fetchFromCopy: async (root, remote, url, branch): Promise<GitWrite> => {
            calls.push(`fetch ${root} ${remote} ${url} ${branch}`);
            return {ok: true};
        },
        addWorktree: async (root, worktree, branch, base): Promise<BringBackWorktree> => {
            calls.push(`worktree ${worktree} ${branch} ${base}`);
            return {ok: true};
        },
        ...over,
    };
    return {git, calls};
}

interface AgentScript {
    /** Chunks as they arrived, by upload id. */
    uploads: Map<string, Buffer[]>;
    /** What a `copy-status` answers. */
    copyState: Omit<CopyStateMessage, 'type' | 'requestId'>;
    handoffDone: {ok: boolean; error?: string; dir?: string; reused?: boolean};
    pushOk: boolean;
}

function harness({
    remotes = [VM_HOME],
    git = fakeGit(),
    unreachable = false,
}: {remotes?: RemoteProjectSetting[]; git?: ReturnType<typeof fakeGit>; unreachable?: boolean} = {}) {
    const agent = scriptedAgent();
    const script: AgentScript = {
        uploads: new Map(),
        copyState: {
            ok: true,
            branch: 'feature',
            headOid: 'def456',
            upstream: 'origin/feature',
            unpushed: [],
            uncommitted: [],
        },
        handoffDone: {ok: true, dir: '~/projects/site', reused: false},
        pushOk: true,
    };
    const answer = (message: MacMessage): AgentMessage[] => {
        switch (message.type) {
            case 'upload-begin':
                script.uploads.set(message.uploadId, []);
                return [];
            case 'upload-chunk':
                script.uploads.get(message.uploadId)?.push(Buffer.from(message.dataBase64, 'base64'));
                return [];
            case 'upload-end': {
                const whole = Buffer.concat(script.uploads.get(message.uploadId) ?? []);
                const ok = createHash('sha256').update(whole).digest('hex') === message.sha256;
                return [{type: 'done', requestId: message.requestId, ok, ...(ok ? {} : {error: 'hash mismatch'})}];
            }
            case 'handoff':
                return [
                    {type: 'handoff-progress', requestId: message.requestId, line: 'Cloning joris/site'},
                    {type: 'handoff-progress', requestId: message.requestId, line: 'Applying your changes'},
                    {type: 'handoff-done', requestId: message.requestId, ...script.handoffDone},
                ];
            case 'copy-status':
                return [{type: 'copy-state', requestId: message.requestId, ...script.copyState}];
            case 'push-branch':
                return [{type: 'done', requestId: message.requestId, ok: script.pushOk}];
            case 'remove-copy':
                return [{type: 'done', requestId: message.requestId, ok: true}];
            default:
                return [];
        }
    };
    const dialer = {
        dial: async (host: RemoteConfig) => {
            if (unreachable) agent.failNextDial = 'Permission denied (publickey).';
            const link = await agent.dialer.dial(host);
            const pair = agent.current();
            pair.agent.onMessage((message) => answer(message).forEach((reply) => pair.agent.send(reply)));
            return link;
        },
    };
    const connections = new Map<string, AgentConnection>();
    const connectionFor = (host: RemoteConfig) => {
        const key = `${host.user}@${host.host}:${host.port}`;
        let connection = connections.get(key);
        if (!connection) {
            connection = new AgentConnection({
                host,
                dialer,
                appVersion: '2.12.0',
                timers: fakeTimers(),
                clock: {now: () => 1_000_000},
                log: silentLog,
            });
            connections.set(key, connection);
        }
        return connection;
    };
    const settings = new SettingsService(new MemoryStore());
    for (const remote of remotes) settings.addRemoteProject(remote);
    const renderer = fakeRenderer();
    const forgotten: string[] = [];
    const service = new ProjectHandoffService({
        agents: {connection: connectionFor},
        git: git.git,
        settings,
        renderer,
        forgetRemoteProject: (projectPath) => {
            forgotten.push(projectPath);
            settings.removeRemoteProject(projectPath);
        },
        timers: fakeTimers(),
        log: silentLog,
    });
    return {service, agent, script, settings, renderer, forgotten, git};
}

function copySetting(over: Partial<RemoteProjectSetting> = {}): RemoteProjectSetting {
    return {user: 'dev', host: 'vm.local', port: 22, dir: '~/projects/site', agent: AGENT, copyOf: LOCAL, ...over};
}

// ── Hosts and preview ──

test('the hosts are one per VM with an agent, agentless remotes left out', () => {
    /* Given */
    const h = harness({
        remotes: [
            VM_HOME,
            {...VM_HOME, dir: 'other'},
            {user: 'dev', host: 'build', port: 2222, dir: null, agent: AGENT},
            {user: 'pi', host: 'pi.local', port: 22, dir: null},
        ],
    });

    /* When */
    const hosts = h.service.hosts();

    /* Then */
    assert.deepEqual(hosts, [
        {key: 'dev@vm.local:22', label: 'dev@vm.local'},
        {key: 'dev@build:2222', label: 'dev@build:2222'},
    ]);
});

test('a preview gives the branch, the counts and the config candidates, keys unticked', async () => {
    /* Given */
    const h = harness();

    /* When */
    const preview = await h.service.preview(LOCAL);

    /* Then */
    assert.deepEqual(preview, {
        branch: 'feature',
        unpushed: 2,
        uncommitted: 2,
        candidates: [
            {path: '.env', size: 9, ticked: true},
            {path: '.env.local', size: 8, ticked: true},
            {path: 'certs/dev.pem', size: 4, ticked: false},
        ],
        existing: {},
    });
});

test('a preview ticks what was carried last time, and names the existing copy', async () => {
    /* Given */
    const h = harness({remotes: [VM_HOME, copySetting()]});
    h.settings.rememberHandoffFiles(LOCAL, ['certs/dev.pem']);

    /* When */
    const preview = await h.service.preview(LOCAL);

    /* Then */
    assert.ok(!('error' in preview));
    assert.deepEqual(
        preview.candidates.map((c) => [c.path, c.ticked]),
        [
            ['.env', false],
            ['.env.local', false],
            ['certs/dev.pem', true],
        ],
    );
    assert.deepEqual(preview.existing, {'dev@vm.local:22': COPY});
});

test('a folder that is not a repository, or has no origin, gets a plain error', async () => {
    /* Given */
    const noOrigin = harness({git: fakeGit({originUrl: async () => null})});
    const h = harness();

    /* When */
    const notRepo = await h.service.preview('/Users/joris/Downloads');
    const withoutOrigin = await noOrigin.service.preview(LOCAL);

    /* Then */
    assert.deepEqual(notRepo, {error: 'This folder is not a git repository, so there is nothing to hand off.'});
    assert.deepEqual(withoutOrigin, {error: 'This repository has no origin remote for the VM to clone from.'});
});

// ── Hand-off ──

test('a hand-off uploads the bundle and patch in verified chunks and sends handoff with the repo, branch and HEAD', async () => {
    /* Given */
    const h = harness();

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', ['.env']);

    /* Then */
    assert.deepEqual(result, {ok: true, copyPath: COPY, reused: false});
    const ends = h.agent.sent('upload-end');
    assert.equal(ends.length, 2);
    const [bundleId, patchId] = ends.map((end) => end.uploadId);
    assert.equal(Buffer.concat(h.script.uploads.get(bundleId) ?? []).toString(), 'BUNDLE');
    assert.equal(Buffer.concat(h.script.uploads.get(patchId) ?? []).toString(), 'PATCH');
    assert.deepEqual(
        h.agent.sent('upload-begin').map((begin) => begin.size),
        [6, 5],
    );
    const [handoff] = h.agent.sent('handoff');
    assert.deepEqual({...handoff, requestId: 'r'} satisfies HandoffMessage, {
        type: 'handoff',
        requestId: 'r',
        repo: {name: 'site', origin: 'git@github.com:joris/site.git', github: 'joris/site'},
        branch: 'feature',
        headOid: 'abc123',
        bundleUploadId: bundleId,
        patchUploadId: patchId,
        files: [{path: '.env', contentBase64: Buffer.from('SECRET=1\n').toString('base64'), mode: 0o600}],
    });
});

test('a large upload goes in chunks that reassemble to the file', async () => {
    /* Given */
    const big = Buffer.alloc(9 * 1024 * 1024 + 17, 7);
    const h = harness({
        git: fakeGit({
            bundle: async () => ({bytes: big, sha256: createHash('sha256').update(big).digest('hex')}),
            patch: async () => null,
        }),
    });

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', []);

    /* Then */
    assert.equal(result.ok, true);
    const chunks = h.agent.sent('upload-chunk');
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((chunk) => Buffer.from(chunk.dataBase64, 'base64').length <= 4 * 1024 * 1024));
    const [handoff] = h.agent.sent('handoff');
    assert.equal(handoff.patchUploadId, undefined);
    assert.ok(handoff.bundleUploadId);
    assert.deepEqual(Buffer.concat(h.script.uploads.get(handoff.bundleUploadId) ?? []), big);
});

test("the agent's progress lines reach the caller after the Mac's own", async () => {
    /* Given */
    const h = harness();
    const lines: string[] = [];

    /* When */
    await h.service.handOff(LOCAL, 'dev@vm.local:22', [], (line) => lines.push(line));

    /* Then */
    assert.deepEqual(lines, [
        'Connecting to dev@vm.local',
        'Uploading the unpushed commits (6 B)',
        'Uploading the uncommitted changes (5 B)',
        'Handing site off to dev@vm.local',
        'Cloning joris/site',
        'Applying your changes',
    ]);
});

test('a successful hand-off links the copy as a VM project and remembers the ticked files', async () => {
    /* Given */
    const h = harness();

    /* When */
    await h.service.handOff(LOCAL, 'dev@vm.local:22', ['.env', 'certs/dev.pem']);

    /* Then */
    assert.deepEqual(h.settings.findRemoteProject(COPY), copySetting());
    assert.deepEqual(h.settings.handoffFiles(LOCAL), ['.env', 'certs/dev.pem']);
    assert.deepEqual(h.service.copiesOf(LOCAL), [
        {copyPath: COPY, hostKey: 'dev@vm.local:22', hostLabel: 'dev@vm.local'},
    ]);
    assert.equal(h.service.originOf(COPY), LOCAL);
    assert.equal(h.service.originOf('ssh://dev@vm.local'), null);
    assert.ok(h.renderer.events.some(([name]) => name === 'projectsChanged'));
});

test('a second hand-off updates the same copy and keeps its sessions', async () => {
    /* Given */
    const sessions = [{sessionId: 's1', kind: 'claude', created: '2026-11-01T00:00:00.000Z'}];
    const h = harness({remotes: [VM_HOME, copySetting({sessions})]});
    h.script.handoffDone = {ok: true, dir: '~/projects/site', reused: true};

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', []);

    /* Then */
    assert.deepEqual(result, {ok: true, copyPath: COPY, reused: true});
    assert.equal(h.settings.remoteProjects().length, 2);
    assert.deepEqual(h.settings.findRemoteProject(COPY)?.sessions, sessions);
});

test("a failed hand-off says the agent's step and links nothing", async () => {
    /* Given */
    const h = harness();
    h.script.handoffDone = {ok: false, error: 'Applying the patch failed: b.txt does not match'};

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', ['.env']);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'Applying the patch failed: b.txt does not match'});
    assert.equal(h.settings.findRemoteProject(COPY), null);
    assert.equal(h.settings.handoffFiles(LOCAL), null);
});

test('a file that was not offered is refused before anything is sent', async () => {
    /* Given */
    const h = harness();

    /* When */
    const tracked = await h.service.handOff(LOCAL, 'dev@vm.local:22', ['src/index.ts']);
    const escaping = await h.service.handOff(LOCAL, 'dev@vm.local:22', ['../.ssh/id_ed25519']);
    const tooBig = await h.service.handOff(LOCAL, 'dev@vm.local:22', ['big.local']);

    /* Then */
    assert.equal(tracked.ok, false);
    assert.equal(escaping.ok, false);
    assert.equal(tooBig.ok, false);
    assert.equal(h.agent.dials.length, 0);
});

test('an unreachable host fails the hand-off in plain words', async () => {
    /* Given */
    const h = harness({unreachable: true});

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', []);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'Could not reach dev@vm.local: Permission denied (publickey).'});
    assert.equal(h.settings.findRemoteProject(COPY), null);
});

test('a host that is not a VM is refused', async () => {
    /* Given */
    const h = harness();

    /* When */
    const result = await h.service.handOff(LOCAL, 'pi@pi.local:22', []);

    /* Then */
    assert.equal(result.ok, false);
});

// ── Copy status ──

test("a copy's status comes from its agent", async () => {
    /* Given */
    const h = harness({remotes: [VM_HOME, copySetting()]});
    h.script.copyState = {
        ok: true,
        branch: 'feature',
        upstream: 'origin/feature',
        unpushed: [{oid: 'def456', subject: 'Fix it'}],
        uncommitted: ['b.txt'],
    };

    /* When */
    const status = await h.service.copyStatus(COPY);

    /* Then */
    assert.deepEqual(status, {
        branch: 'feature',
        unpushed: [{oid: 'def456', subject: 'Fix it'}],
        uncommitted: ['b.txt'],
    });
    assert.deepEqual(
        h.agent.sent('copy-status').map((m) => m.dir),
        ['~/projects/site'],
    );
});

test("an unreachable copy's status is null", async () => {
    /* Given */
    const h = harness({remotes: [VM_HOME, copySetting()], unreachable: true});

    /* When */
    const status = await h.service.copyStatus(COPY);

    /* Then */
    assert.equal(status, null);
});

// ── Bring back ──

test('Bring back pushes unpushed commits from the VM, then fetches and adds a worktree', async () => {
    /* Given */
    const git = fakeGit();
    const h = harness({remotes: [VM_HOME, copySetting()], git});
    h.script.copyState = {...h.script.copyState, unpushed: [{oid: 'def456', subject: 'Fix it'}]};
    const lines: string[] = [];

    /* When */
    const result = await h.service.bringBack(COPY, (line) => lines.push(line));

    /* Then */
    const worktree = `${LOCAL}/.claude/worktrees/feature`;
    assert.deepEqual(result, {ok: true, worktree, branch: 'feature'});
    // Fetched straight from the copy: nothing is pushed, so unpushed work stays unpublished.
    assert.equal(h.agent.sent('push-branch').length, 0);
    assert.deepEqual(git.calls, [
        `fetch ${LOCAL} vm-vm.local ssh://dev@vm.local/~/projects/site feature`,
        `worktree ${worktree} feature vm-vm.local/feature`,
    ]);
    assert.deepEqual(lines, [
        'Checking the copy on the VM',
        'Fetching feature from the VM',
        `Checking feature out in ${worktree}`,
    ]);
});

test('Bring back with nothing unpushed fetches the same way, and pushes nothing', async () => {
    /* Given */
    const h = harness({remotes: [VM_HOME, copySetting()]});

    /* When */
    const result = await h.service.bringBack(COPY);

    /* Then */
    assert.equal(result.ok, true);
    assert.equal(h.agent.sent('push-branch').length, 0);
});

test("Bring back tries another branch name when the copy's branch is checked out here", async () => {
    /* Given */
    const git = fakeGit({
        addWorktree: async (_root, worktree, branch) => {
            git.calls.push(`worktree ${worktree} ${branch}`);
            return branch === 'feature'
                ? {ok: false, reason: `feature is checked out in ${LOCAL}`, taken: true}
                : {ok: true};
        },
    });
    const h = harness({remotes: [VM_HOME, copySetting()], git});

    /* When */
    const result = await h.service.bringBack(COPY);

    /* Then */
    assert.deepEqual(result, {ok: true, worktree: `${LOCAL}/.claude/worktrees/feature-vm`, branch: 'feature-vm'});
});

test('Bring back refuses a detached copy, and one with uncommitted changes, naming them', async () => {
    /* Given */
    const detached = harness({remotes: [VM_HOME, copySetting()]});
    detached.script.copyState = {...detached.script.copyState, branch: null};
    const dirty = harness({remotes: [VM_HOME, copySetting()]});
    dirty.script.copyState = {...dirty.script.copyState, uncommitted: ['b.txt', 'notes/new.txt']};

    /* When */
    const fromDetached = await detached.service.bringBack(COPY);
    const fromDirty = await dirty.service.bringBack(COPY);

    /* Then */
    assert.deepEqual(fromDetached, {
        ok: false,
        error: 'The copy is on a detached HEAD; check out a branch on the VM first.',
    });
    assert.deepEqual(fromDirty, {
        ok: false,
        error: 'The copy has uncommitted changes, which only come back committed: b.txt, notes/new.txt.',
    });
    assert.equal(dirty.agent.sent('push-branch').length, 0);
    assert.deepEqual(dirty.git.calls, []);
});

test('Bring back stops when the fetch from the VM fails', async () => {
    /* Given */
    const git = fakeGit({fetchFromCopy: async () => ({ok: false, reason: 'Permission denied (publickey)'})});
    const h = harness({remotes: [VM_HOME, copySetting()], git});

    /* When */
    const result = await h.service.bringBack(COPY);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'Could not fetch feature from the VM: Permission denied (publickey)'});
});

// ── Removing a copy ──

test('removing a copy deletes it on the VM and forgets the remote project, never the local one', async () => {
    /* Given */
    const h = harness({remotes: [VM_HOME, copySetting()]});

    /* When */
    const result = await h.service.removeCopy(COPY);
    await settle();

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(
        h.agent.sent('remove-copy').map((m) => m.dir),
        ['~/projects/site'],
    );
    assert.deepEqual(h.forgotten, [COPY]);
    assert.equal(h.settings.findRemoteProject(COPY), null);
    assert.deepEqual(h.service.copiesOf(LOCAL), []);
});

test('a remote that is not a copy is never removed', async () => {
    /* Given */
    const h = harness({remotes: [VM_HOME, {...VM_HOME, dir: 'apps/site'}]});

    /* When */
    const result = await h.service.removeCopy('ssh://dev@vm.local/apps/site');

    /* Then */
    assert.equal(result.ok, false);
    assert.equal(h.agent.sent('remove-copy').length, 0);
    assert.deepEqual(h.forgotten, []);
});

test('an unreachable copy is not forgotten', async () => {
    /* Given */
    const h = harness({remotes: [VM_HOME, copySetting()], unreachable: true});

    /* When */
    const result = await h.service.removeCopy(COPY);

    /* Then */
    assert.equal(result.ok, false);
    assert.deepEqual(h.forgotten, []);
    assert.ok(h.settings.findRemoteProject(COPY));
});

// ── A worktree's hand-off (#276 stage 3) ──

const WORKTREE = `${LOCAL}/.claude/worktrees/fix-login`;
const WORKTREE_COPY = 'ssh://dev@vm.local/~/projects/site/.claude/worktrees/fix-login';

/** The fake repository with a linked worktree on its own branch and HEAD. */
function worktreeGit() {
    return fakeGit({
        repositoryRoot: async (cwd) => (cwd === LOCAL ? LOCAL : cwd === WORKTREE ? WORKTREE : null),
        currentBranch: async (root) => (root === WORKTREE ? 'fix-login' : 'feature'),
        headOid: async (root) => (root === WORKTREE ? 'wt999' : 'abc123'),
    });
}

test("a worktree's hand-off sends its name, branch and HEAD into the project's copy", async () => {
    /* Given */
    const h = harness({git: worktreeGit()});
    h.script.handoffDone = {ok: true, dir: '~/projects/site/.claude/worktrees/fix-login', reused: true};

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', [], undefined, {
        worktree: {name: 'fix-login', checkout: WORKTREE},
    });

    /* Then */
    assert.deepEqual(result, {ok: true, copyPath: WORKTREE_COPY, reused: true});
    const [handoff] = h.agent.sent('handoff');
    assert.equal(handoff.repo.name, 'site');
    assert.equal(handoff.worktree, 'fix-login');
    assert.equal(handoff.branch, 'fix-login');
    assert.equal(handoff.headOid, 'wt999');
    assert.equal(h.settings.findRemoteProject(WORKTREE_COPY)?.copyOf, LOCAL);
});

test("a worktree's copy falls back to <copy>/.claude/worktrees/<name> when the agent names no folder", async () => {
    /* Given */
    const h = harness({git: worktreeGit()});
    h.script.handoffDone = {ok: true};

    /* When */
    const result = await h.service.handOff(LOCAL, 'dev@vm.local:22', [], undefined, {
        worktree: {name: 'fix-login', checkout: WORKTREE},
    });

    /* Then */
    assert.deepEqual(result, {ok: true, copyPath: WORKTREE_COPY, reused: false});
});

test("a worktree's preview counts the worktree's checkout but keeps the project's copies", async () => {
    /* Given */
    const h = harness({remotes: [VM_HOME, copySetting()], git: worktreeGit()});

    /* When */
    const preview = await h.service.preview(LOCAL, {checkout: WORKTREE});

    /* Then */
    assert.ok(!('error' in preview));
    assert.equal(preview.branch, 'fix-login');
    assert.deepEqual(preview.existing, {'dev@vm.local:22': COPY});
});
