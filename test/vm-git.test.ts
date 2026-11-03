/**
 * The Mac's git for VM paths (#276 stage 4): a VM-named GitCliWorkspace over a
 * real AgentConnection, against an agent end that really runs git on a temp
 * repository standing in for the VM.
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {AGENT_PROTOCOL_VERSION} from '../src/domain/agent/protocol';
import type {MacMessage} from '../src/domain/agent/protocol';
import {splitVmPath, vmPath} from '../src/domain/agent/vm-paths';
import type {VmHost} from '../src/domain/agent/vm-paths';
import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import type {AgentDialer} from '../src/application/ports/agent-link';
import {GitCliWorkspace} from '../src/infrastructure/git/git-cli-workspace';
import {GitCliRemotes} from '../src/infrastructure/git/git-cli-remotes';
import {VmGitRunner} from '../src/infrastructure/git/vm-git-runner';
import type {AgentTools} from '../src/infrastructure/git/vm-git-runner';
import {linkPair} from './support/agent-link';
import type {LinkPair} from './support/agent-link';
import {fakeTimers, silentLog} from './support/fakes';
import {HOST_SETTINGS} from './support/scripted-agent';

// Keep the developer's own git config out of both the fixture and the agent's runs.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = os.devNull;

const HOST: VmHost = {user: 'dev', host: 'vm.test', port: 22};
const PREFIX = 'ssh://dev@vm.test/';

let home: string;
let repo: string;
let linked: string;

function run(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function commit(dir: string, file: string, content: string, message: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
    fs.writeFileSync(path.join(dir, file), content);
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', message);
}

before(() => {
    // The temp folder is the VM user's home: `~/repo` is the project.
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-vm-git-')));
    repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    run(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'a.txt', 'one\n', 'Initial');
    run(repo, 'remote', 'add', 'origin', 'git@github.com:acme/web.git');
    linked = path.join(repo, '.claude', 'worktrees', 'feature');
    run(repo, 'worktree', 'add', '-q', '-b', 'feature', linked, 'main');
    commit(linked, 'b.txt', 'feature\n', 'Feature');
    // Uncommitted work in the main checkout: an edit and a new file.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh\n');
    // Next to the checkout, not in it: never read through a `..`.
    fs.writeFileSync(path.join(home, 'outside.txt'), 'secret\n');
});

after(() => fs.rmSync(home, {recursive: true, force: true}));

/**
 * The VM's agent, for real: `run-tool` runs git here, `read-file` and
 * `stat-files` read this disk, and `watch-dir` watches the folder's git dir.
 * `home` is what its `welcome` says (null for an agent older than stage 4).
 */
function vmAgent({sayHome = true}: {sayHome?: boolean} = {}) {
    const dials: LinkPair[] = [];
    const watchers = new Map<string, fs.FSWatcher>();
    const dialer: AgentDialer = {
        async dial() {
            const pair = linkPair();
            dials.push(pair);
            const reply = pair.agent.send.bind(pair.agent);
            pair.agent.onMessage((message: MacMessage) => {
                switch (message.type) {
                    case 'hello':
                        return reply({
                            type: 'welcome',
                            protocol: AGENT_PROTOCOL_VERSION,
                            agentVersion: message.appVersion,
                            settings: HOST_SETTINGS,
                            ...(sayHome ? {home} : {}),
                        });
                    case 'run-tool': {
                        assert.ok(path.isAbsolute(message.cwd), `cwd must be absolute: ${message.cwd}`);
                        const child = execFile(
                            message.tool,
                            message.tool === 'git' ? ['-C', message.cwd, ...message.args] : message.args,
                            {encoding: 'buffer', cwd: message.cwd},
                            (err, stdout, stderr) => {
                                const code = (err as {code?: unknown} | null)?.code;
                                reply({
                                    type: 'tool-result',
                                    requestId: message.requestId,
                                    code: err ? (typeof code === 'number' ? code : -1) : 0,
                                    stdoutBase64: stdout.toString('base64'),
                                    stderr: stderr.toString('utf8'),
                                });
                            },
                        );
                        if (message.stdinBase64 !== undefined)
                            child.stdin?.end(Buffer.from(message.stdinBase64, 'base64'));
                        else child.stdin?.end();
                        return;
                    }
                    case 'stat-files': {
                        const sizes: Record<string, number> = {};
                        for (const file of message.paths) {
                            try {
                                const stat = fs.lstatSync(file);
                                if (stat.isFile()) sizes[file] = stat.size;
                            } catch {
                                // Not there.
                            }
                        }
                        return reply({type: 'file-stats', requestId: message.requestId, sizes});
                    }
                    case 'read-file': {
                        try {
                            const bytes = fs.readFileSync(message.path);
                            return reply({
                                type: 'file-content',
                                requestId: message.requestId,
                                found: true,
                                contentBase64: bytes.toString('base64'),
                            });
                        } catch {
                            return reply({type: 'file-content', requestId: message.requestId, found: false});
                        }
                    }
                    case 'watch-dir': {
                        // The folder's own git dir: a linked worktree's `.git` is only a pointer file.
                        const gitDir = execFileSync('git', ['-C', message.dir, 'rev-parse', '--absolute-git-dir'], {
                            encoding: 'utf8',
                        }).trim();
                        const watcher = fs.watch(gitDir, {recursive: true}, () =>
                            reply({type: 'dir-changed', watchId: message.watchId}),
                        );
                        watchers.set(message.watchId, watcher);
                        return;
                    }
                    case 'unwatch-dir':
                        watchers.get(message.watchId)?.close();
                        watchers.delete(message.watchId);
                        return;
                    default:
                        return;
                }
            });
            return pair.mac;
        },
    };
    const connection = new AgentConnection({
        host: HOST,
        dialer,
        appVersion: '2.12.0',
        timers: fakeTimers(),
        clock: {now: () => 0},
        log: silentLog,
    });
    const tools: AgentTools = connection;
    return {
        connection,
        dials,
        sent: () => dials.flatMap((pair) => pair.sentByMac),
        git: new GitCliWorkspace(new VmGitRunner(HOST, () => tools)),
        close() {
            for (const watcher of watchers.values()) watcher.close();
            connection.close();
        },
    };
}

/** The VM path a name stands for, asserting it is a VM name on HOST. */
function onVm(name: string | null | undefined): string {
    assert.ok(name, 'expected a path');
    assert.ok(name.startsWith(PREFIX + '/'), `expected a VM name, got ${name}`);
    const split = splitVmPath(name);
    assert.deepEqual(split?.host, HOST);
    return split!.path;
}

test('a VM project at ~/repo resolves to its VM-named root, and every path it hands back is VM-named', async () => {
    /* Given */
    const vm = vmAgent();
    const project = PREFIX + '~/repo';

    try {
        /* When */
        const root = await vm.git.worktreeRoot(project);
        const worktrees = await vm.git.worktrees(root!);
        const main = await vm.git.mainCheckout(vmPath(HOST, linked));

        /* Then */
        assert.equal(root, vmPath(HOST, repo));
        assert.equal(onVm(root), repo);
        assert.deepEqual(
            worktrees.map((w) => ({path: onVm(w.path), branch: w.branch, main: w.main})),
            [
                {path: repo, branch: 'main', main: true},
                {path: linked, branch: 'feature', main: false},
            ],
        );
        assert.equal(worktrees[0].changedFiles, 2);
        assert.equal(worktrees[1].ahead, 1, 'no origin/main, so ahead counts against main');
        assert.equal(main, root);
    } finally {
        vm.close();
    }
});

test('the names a VM workspace hands back feed its next calls: status, diffs, blobs and files', async () => {
    /* Given */
    const vm = vmAgent();

    try {
        const [, feature] = await vm.git.worktrees((await vm.git.worktreeRoot(PREFIX + '~/repo'))!);
        const root = (await vm.git.mainCheckout(feature.path))!;

        /* When */
        const status = await vm.git.status(root);
        const working = await vm.git.workingDiff(root);
        const blob = await vm.git.blob(root, 'HEAD', 'a.txt');
        const sizes = await vm.git.workingFileSizes(root, ['a.txt', 'new.txt', '../escape', 'missing.txt']);
        const file = await vm.git.workingFile(root, 'a.txt');
        const outside = await vm.git.workingFile(root, '../outside.txt');
        const branch = await vm.git.branchDiff(feature.path, 'feature', 'main');
        const sha = await vm.git.commitSha(feature.path, 'feature');

        /* Then */
        assert.deepEqual(status, [
            {path: 'a.txt', status: 'modified'},
            {path: 'new.txt', status: 'untracked'},
        ]);
        assert.match(working, /\+two/);
        assert.match(working, /\+\+\+ b\/new\.txt/);
        assert.equal(Buffer.from(blob!).toString('utf8'), 'one\n');
        assert.deepEqual(Object.fromEntries(sizes), {'a.txt': 8, 'new.txt': 6});
        assert.equal(Buffer.from(file!).toString('utf8'), 'one\ntwo\n');
        assert.equal(outside, null);
        assert.match(branch, /\+\+\+ b\/b\.txt/);
        assert.equal(sha, run(linked, 'rev-parse', 'feature').trim());
    } finally {
        vm.close();
    }
});

test('every git the VM runs is in an absolute folder, with no optional locks', async () => {
    /* Given */
    const vm = vmAgent();

    try {
        /* When */
        await vm.git.status(PREFIX + '~/repo');

        /* Then */
        const runs = vm.sent().filter((m) => m.type === 'run-tool');
        assert.deepEqual(
            runs.map((m) => m.type === 'run-tool' && [m.tool, m.cwd, m.args[0]]),
            [['git', repo, '--no-optional-locks']],
        );
    } finally {
        vm.close();
    }
});

test('a worktree written to on the VM goes there by its VM path and comes back VM-named', async () => {
    /* Given */
    const vm = vmAgent();
    const root = vmPath(HOST, repo);
    const target = root + '/.claude/worktrees/other';

    try {
        /* When */
        const added = await vm.git.addWorktree(root, target, 'other', 'main');
        const listed = (await vm.git.worktrees(root)).map((w) => w.path);
        const removed = await vm.git.removeWorktree(root, target);
        const elsewhere = await vm.git.addWorktree(root, 'ssh://dev@other.test//tmp/x', 'x', 'main');

        /* Then */
        assert.deepEqual(added, {ok: true});
        assert.ok(listed.includes(target), `expected ${target} in ${listed.join(', ')}`);
        assert.deepEqual(removed, {ok: true});
        assert.equal(fs.existsSync(path.join(repo, '.claude', 'worktrees', 'other')), false);
        assert.equal(elsewhere.ok, false);
        run(repo, 'branch', '-D', 'other');
    } finally {
        vm.close();
    }
});

test("a VM workspace's watch hears of a commit through the agent, and stops when disposed", async () => {
    /* Given */
    const vm = vmAgent();
    const root = vmPath(HOST, linked);
    await vm.connection.whenConnected();
    let heard = 0;
    const heardOnce = new Promise<void>((resolve) => {
        const watch = vm.git.watch(root, () => {
            heard++;
            watch.dispose();
            resolve();
        });
    });
    await new Promise((resolve) => setImmediate(resolve));

    try {
        /* When */
        commit(linked, 'c.txt', 'more\n', 'More');
        await heardOnce;

        /* Then */
        assert.equal(heard, 1);
        const watchDir = vm.sent().find((m) => m.type === 'watch-dir');
        assert.deepEqual(watchDir && watchDir.type === 'watch-dir' && watchDir.dir, linked);
        assert.ok(vm.sent().some((m) => m.type === 'unwatch-dir'));
    } finally {
        vm.close();
    }
});

test('an agent that does not say its home answers nothing for a ~ path, but still serves absolute ones', async () => {
    /* Given */
    const vm = vmAgent({sayHome: false});

    try {
        /* When */
        const fromTilde = await vm.git.worktreeRoot(PREFIX + '~/repo');
        const fromAbsolute = await vm.git.worktreeRoot(vmPath(HOST, repo));

        /* Then */
        assert.equal(fromTilde, null);
        assert.equal(fromAbsolute, vmPath(HOST, repo));
    } finally {
        vm.close();
    }
});

test("GitCliRemotes over a VM runner reads the VM checkout's origin", async () => {
    /* Given */
    const vm = vmAgent();
    const remotes = new GitCliRemotes(new VmGitRunner(HOST, () => vm.connection));

    try {
        /* When */
        const url = await remotes.originUrl(PREFIX + '~/repo');

        /* Then */
        assert.equal(url, 'git@github.com:acme/web.git');
    } finally {
        vm.close();
    }
});
