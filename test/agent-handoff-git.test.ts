import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {GitCliHandoff} from '../src/infrastructure/git/git-cli-handoff';
import {isConfigCandidate} from '../src/domain/agent/handoff';

/**
 * The hand-off's git, for real (#276 stage 2): a bare origin, a clone with
 * unpushed commits and every kind of uncommitted change, and ignored config
 * next to ignored dependencies. What goes to the VM has to rebuild the Mac's
 * working tree exactly, and the user's index must never change.
 */

// Keep the developer's own git config out of both the fixture and the adapter.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = os.devNull;

const git = new GitCliHandoff();
let tmp: string;
let origin: string;
let repo: string;
let pusher: string;
let pushedOid: string;

function run(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function write(dir: string, file: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
    fs.writeFileSync(path.join(dir, file), content);
}

function commit(dir: string, file: string, content: string, message: string): void {
    write(dir, file, content);
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '-m', message);
}

/** Every file under `dir` but `.git` and the ignored folders, with its bytes. */
function tree(dir: string, skip: readonly string[] = []): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (at: string) => {
        for (const entry of fs.readdirSync(at, {withFileTypes: true})) {
            const full = path.join(at, entry.name);
            const relative = path.relative(dir, full);
            if (entry.name === '.git' || skip.includes(relative)) continue;
            if (entry.isDirectory()) walk(full);
            else files[relative] = fs.readFileSync(full).toString('base64');
        }
    };
    walk(dir);
    return files;
}

const IGNORED = ['.env', '.env.local', 'node_modules', 'config/app.local.json', 'server.key', 'build', 'link.local'];

before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-handoff-')));
    origin = path.join(tmp, 'origin.git');
    repo = path.join(tmp, 'repo');
    pusher = path.join(tmp, 'pusher');

    run(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    run(tmp, 'clone', '-q', origin, pusher);
    write(pusher, '.gitignore', '.env\n.env.*\nnode_modules/\n*.local\nconfig/*.local.*\n*.key\nbuild/\n');
    write(pusher, 'config/app.json', '{}\n');
    write(pusher, 'b.txt', 'b\n');
    write(pusher, 'c.txt', 'c\n');
    commit(pusher, 'a.txt', 'a\n', 'Initial');
    run(pusher, 'push', '-q', 'origin', 'HEAD:main');
    pushedOid = run(pusher, 'rev-parse', 'HEAD').trim();
    run(tmp, 'clone', '-q', origin, repo);

    // Two commits origin does not have.
    commit(repo, 'd.txt', 'd\n', 'Unpushed one');
    commit(repo, 'e.txt', 'e\n', 'Unpushed two');

    // Staged, unstaged, deleted, untracked (one binary) and a staged new file.
    write(repo, 'a.txt', 'a, staged\n');
    run(repo, 'add', 'a.txt');
    write(repo, 'staged.txt', 'new and staged\n');
    run(repo, 'add', 'staged.txt');
    write(repo, 'b.txt', 'b, unstaged\n');
    fs.rmSync(path.join(repo, 'c.txt'));
    write(repo, 'notes/new.txt', 'untracked\n');
    write(repo, 'bin.dat', Buffer.from(Array.from({length: 256}, (_, i) => i)));

    // Ignored: config worth carrying, and dependencies and build output never.
    write(repo, '.env', 'SECRET=1\n');
    fs.chmodSync(path.join(repo, '.env'), 0o600);
    write(repo, '.env.local', 'LOCAL=1\n');
    write(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    write(repo, 'node_modules/pkg/.env', 'NOPE=1\n');
    write(repo, 'config/app.local.json', '{"local": true}\n');
    write(repo, 'server.key', 'KEY\n');
    write(repo, 'build/out.js', 'built\n');
    fs.symlinkSync('/etc/hosts', path.join(repo, 'link.local'));
});

after(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
});

test('the repository, its branch, HEAD and origin are read', async () => {
    /* When */
    const root = await git.repositoryRoot(path.join(repo, 'notes'));
    const branch = await git.currentBranch(repo);
    const head = await git.headOid(repo);
    const originUrl = await git.originUrl(repo);

    /* Then */
    assert.equal(root, repo);
    assert.equal(branch, 'main');
    assert.equal(head, run(repo, 'rev-parse', 'HEAD').trim());
    assert.equal(originUrl, origin);
});

test('the unpushed commits are counted', async () => {
    /* When */
    const count = await git.unpushedCount(repo);

    /* Then */
    assert.equal(count, 2);
});

test('the bundle holds exactly the unpushed commits, with HEAD as its ref', async () => {
    /* Given */
    const head = run(repo, 'rev-parse', 'HEAD').trim();
    const fresh = path.join(tmp, 'bundle-check');
    run(tmp, 'clone', '-q', origin, fresh);

    /* When */
    const bundle = await git.bundle(repo);

    /* Then */
    assert.ok(bundle);
    const file = path.join(tmp, 'check.bundle');
    fs.writeFileSync(file, bundle.bytes);
    assert.equal(run(fresh, 'bundle', 'list-heads', file).trim(), `${head} HEAD`);
    run(fresh, 'bundle', 'verify', '-q', file);
    run(fresh, 'fetch', '-q', file, 'HEAD:refs/heads/handed');
    const carried = run(fresh, 'rev-list', 'handed', '--not', '--remotes=origin').trim().split('\n');
    assert.deepEqual(carried, run(repo, 'rev-list', 'HEAD', '--not', '--remotes=origin').trim().split('\n'));
    assert.equal(carried.length, 2);
    assert.match(bundle.sha256, /^[0-9a-f]{64}$/);
});

test('with nothing unpushed there is no bundle', async () => {
    /* Given */
    const clean = path.join(tmp, 'clean');
    run(tmp, 'clone', '-q', origin, clean);

    /* When */
    const bundle = await git.bundle(clean);
    const patch = await git.patch(clean);

    /* Then */
    assert.equal(bundle, null);
    assert.equal(patch, null);
});

test("the patch leaves out Switchboard's worktrees and nested repositories when .claude is not ignored", async () => {
    /* Given */
    const local = path.join(tmp, 'nested');
    run(tmp, 'clone', '-q', origin, local);
    fs.writeFileSync(path.join(local, 'real.txt'), 'a real change\n');
    run(local, 'worktree', 'add', '-q', '-b', 'wt-nested', path.join(local, '.claude/worktrees/wt1'));
    const embedded = path.join(local, 'vendor/lib');
    fs.mkdirSync(embedded, {recursive: true});
    run(embedded, 'init', '-q');
    commit(embedded, 'x.txt', 'x\n', 'embedded');

    /* When */
    const patch = await git.patch(local);
    const uncommitted = await git.uncommittedPaths(local);

    /* Then */
    const text = patch ? Buffer.from(patch.bytes).toString('utf8') : '';
    assert.match(text, /real\.txt/);
    assert.doesNotMatch(text, /\.claude\/worktrees/);
    assert.doesNotMatch(text, /Subproject commit|vendor\/lib/);
    assert.ok(uncommitted.every((p) => !p.startsWith('.claude/worktrees')));
});

test('the patch applied to origin plus the bundle rebuilds the working tree', async () => {
    /* Given */
    const head = run(repo, 'rev-parse', 'HEAD').trim();
    const fresh = path.join(tmp, 'patch-check');
    run(tmp, 'clone', '-q', origin, fresh);
    const bundle = await git.bundle(repo);
    assert.ok(bundle);
    fs.writeFileSync(path.join(tmp, 'apply.bundle'), bundle.bytes);
    run(fresh, 'fetch', '-q', path.join(tmp, 'apply.bundle'), 'HEAD:refs/heads/handed');
    run(fresh, 'checkout', '-q', head);

    /* When */
    const patch = await git.patch(repo);

    /* Then */
    assert.ok(patch);
    fs.writeFileSync(path.join(tmp, 'changes.patch'), patch.bytes);
    run(fresh, 'apply', '--binary', path.join(tmp, 'changes.patch'));
    assert.deepEqual(tree(fresh), tree(repo, IGNORED));
});

test("the user's index is byte for byte the same after every question", async () => {
    /* Given */
    const index = path.join(repo, '.git', 'index');
    const before = fs.readFileSync(index);
    const staged = run(repo, 'diff', '--cached', '--name-only');

    /* When */
    await git.bundle(repo);
    await git.patch(repo);
    await git.uncommittedPaths(repo);
    await git.ignoredPaths(repo);
    await git.unpushedCount(repo);

    /* Then */
    assert.deepEqual(fs.readFileSync(index), before);
    assert.equal(run(repo, 'diff', '--cached', '--name-only'), staged);
    assert.equal(fs.existsSync(index + '.lock'), false);
});

test('the uncommitted paths are every change, untracked included and ignored left out', async () => {
    /* When */
    const paths = await git.uncommittedPaths(repo);

    /* Then */
    assert.deepEqual([...paths].sort(), ['a.txt', 'b.txt', 'bin.dat', 'c.txt', 'notes/new.txt', 'staged.txt']);
});

test('the ignored config files come out as candidates, and dependencies and build output do not', async () => {
    /* When */
    const ignored = await git.ignoredPaths(repo);
    const sizes = await git.fileSizes(repo, ignored.filter(isConfigCandidate));

    /* Then */
    assert.ok(ignored.includes('node_modules/'));
    assert.ok(ignored.includes('build/'));
    assert.deepEqual(ignored.filter(isConfigCandidate).sort(), [
        '.env',
        '.env.local',
        'config/app.local.json',
        'link.local',
        'server.key',
    ]);
    // A symlink is not a file to carry.
    assert.deepEqual([...sizes.keys()].sort(), ['.env', '.env.local', 'config/app.local.json', 'server.key']);
    assert.equal(sizes.get('.env'), 'SECRET=1\n'.length);
});

test('a carried file keeps its bytes and its mode, and nothing outside the checkout is read', async () => {
    /* When */
    const env = await git.readFile(repo, '.env');
    const outside = await git.readFile(repo, '../origin.git/HEAD');
    const linked = await git.readFile(repo, 'link.local');

    /* Then */
    assert.ok(env);
    assert.equal(Buffer.from(env.bytes).toString('utf8'), 'SECRET=1\n');
    assert.equal(env.mode, 0o600);
    assert.equal(outside, null);
    assert.equal(linked, null);
});

test('Bring back fetches a branch straight from the copy and checks it out in a worktree, pushing nothing', async () => {
    /* Given */
    const local = path.join(tmp, 'bring-back');
    run(tmp, 'clone', '-q', origin, local);
    run(pusher, 'checkout', '-q', '-b', 'from-vm');
    commit(pusher, 'vm.txt', 'from the VM\n', 'Work on the VM');
    const vmHead = run(pusher, 'rev-parse', 'HEAD').trim();
    const worktree = path.join(local, '.claude/worktrees/from-vm');

    /* When */
    const fetched = await git.fetchFromCopy(local, 'vm-test', pusher, 'from-vm');
    const added = await git.addWorktree(local, worktree, 'from-vm', 'vm-test/from-vm');

    /* Then */
    assert.deepEqual(fetched, {ok: true});
    assert.deepEqual(added, {ok: true});
    assert.equal(run(worktree, 'rev-parse', 'HEAD').trim(), vmHead);
    assert.equal(run(origin, 'branch', '--list', 'from-vm').trim(), '');
});

test('a second Bring back to the same worktree fast-forwards it', async () => {
    /* Given */
    const local = path.join(tmp, 'bring-back');
    const worktree = path.join(local, '.claude/worktrees/from-vm');
    commit(pusher, 'vm2.txt', 'more\n', 'More work on the VM');
    await git.fetchFromCopy(local, 'vm-test', pusher, 'from-vm');

    /* When */
    const added = await git.addWorktree(local, worktree, 'from-vm', 'vm-test/from-vm');

    /* Then */
    assert.deepEqual(added, {ok: true});
    assert.equal(run(worktree, 'rev-parse', 'HEAD').trim(), run(pusher, 'rev-parse', 'HEAD').trim());
});

test('a branch checked out in another checkout is taken, so another name can be tried', async () => {
    /* Given */
    const local = path.join(tmp, 'bring-back');
    await git.fetchFromCopy(local, 'vm-test', pusher, 'main');

    /* When */
    const added = await git.addWorktree(local, path.join(local, '.claude/worktrees/main'), 'main', 'vm-test/main');

    /* Then */
    assert.equal(added.ok, false);
    assert.equal(!added.ok && added.taken, true);
    assert.equal(run(local, 'rev-parse', 'HEAD').trim(), pushedOid);
});

test("the patch keeps git's a/ and b/ prefixes whatever the user's diff config says", async () => {
    /* Given */
    const prefixless = new GitCliHandoff(async () => ({
        ...process.env,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'diff.noprefix',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'diff.mnemonicPrefix',
        GIT_CONFIG_VALUE_1: 'true',
    }));

    /* When */
    const patch = await prefixless.patch(repo);

    /* Then */
    assert.ok(patch);
    assert.match(Buffer.from(patch.bytes).toString('utf8'), /^diff --git a\/a\.txt b\/a\.txt$/m);
});
