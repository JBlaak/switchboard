import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    Copies,
    isPlausibleBranch,
    isSafeFolderName,
    joinDir,
    parsePorcelainZ,
    type CopyCommandRunner,
} from '../src/application/services/agent-host/copies';
import type {CommandResult} from '../src/application/services/agent-host/host-config';
import type {CopiesMessage} from '../src/application/services/agent-host/handlers';
import {COPY_MARKER, type AgentMessage, type HandoffMessage} from '../src/domain/agent/protocol';
import {NodeCopiesFiles} from '../src/infrastructure/agent/node-copies-files';
import {NodeCopyCommandRunner} from '../src/infrastructure/agent/node-copy-command-runner';
import {linkPair} from './support/agent-link';
import {fakeTimers, silentLog, type FakeTimers} from './support/fakes';

/**
 * The agent's project copies (#286), driven through an in-memory link against
 * real git in temp folders: a bare "origin", a "mac" clone with unpushed
 * commits and uncommitted changes, and the bundle and patch built the way the
 * Mac builds them. Only `gh repo clone` is faked, so no test calls GitHub.
 */

/** git that ignores the machine's own config (signing, hooks, default branch) and has an identity. */
const GIT_ENV: Record<string, string> = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
    return execFileSync('git', args, {cwd, env: {...process.env, ...GIT_ENV, ...env}, encoding: 'utf8'});
}

function write(file: string, content: string | Buffer): void {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
}

/** A world: origin, a Mac clone on `feature` with two unpushed commits and a dirty tree, and the VM's home. */
function world() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-copies-')));
    const origin = path.join(root, 'origin.git');
    const mac = path.join(root, 'mac');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['clone', '-q', origin, mac]);
    git(mac, ['checkout', '-q', '-b', 'main']);
    write(path.join(mac, 'README.md'), 'hello\n');
    write(path.join(mac, '.gitignore'), '.env\n');
    git(mac, ['add', '-A']);
    git(mac, ['commit', '-q', '-m', 'first']);
    git(mac, ['push', '-q', 'origin', 'main']);
    git(mac, ['checkout', '-q', '-b', 'feature']);
    write(path.join(mac, 'a.txt'), 'one\n');
    git(mac, ['add', '-A']);
    git(mac, ['commit', '-q', '-m', 'add a']);
    write(path.join(mac, 'b.txt'), 'two\n');
    git(mac, ['add', '-A']);
    git(mac, ['commit', '-q', '-m', 'add b']);
    // Uncommitted: a tracked change, a new text file and a new binary file.
    write(path.join(mac, 'README.md'), 'hello, edited\n');
    write(path.join(mac, 'notes/new.txt'), 'untracked\n');
    write(path.join(mac, 'logo.bin'), Buffer.from([0, 1, 2, 255, 0, 10, 13]));
    write(path.join(mac, '.env'), 'SECRET=1\n');
    return {root, origin, mac, home};
}

/** What the Mac sends: the bundle of what origin lacks, and the patch of the dirty tree. */
function macPayload(mac: string, scratch: string) {
    const bundle = path.join(scratch, `${crypto.randomUUID()}.bundle`);
    git(mac, ['bundle', 'create', '-q', bundle, 'HEAD', '--not', '--remotes=origin']);
    const index = path.join(scratch, `${crypto.randomUUID()}.index`);
    git(mac, ['add', '-A'], {GIT_INDEX_FILE: index});
    const patch = git(mac, ['diff', '--cached', '--binary', 'HEAD'], {GIT_INDEX_FILE: index});
    fs.rmSync(index, {force: true});
    return {
        bundle: fs.readFileSync(bundle),
        patch: Buffer.from(patch, 'utf8'),
        headOid: git(mac, ['rev-parse', 'HEAD']).trim(),
        branch: git(mac, ['symbolic-ref', '--short', 'HEAD']).trim(),
    };
}

interface Harness {
    part: Copies;
    timers: FakeTimers;
    received: AgentMessage[];
    send(message: CopiesMessage): void;
    pair: ReturnType<typeof linkPair>;
}

function harness(
    home: string,
    options: {commands?: CopyCommandRunner; baseFolder?: string; tempRoot?: string; maxUploadBytes?: number} = {},
): Harness {
    const timers = fakeTimers();
    const tempRoot = options.tempRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-uploads-'));
    const part = new Copies({
        commands: options.commands ?? new NodeCopyCommandRunner({env: {...process.env, ...GIT_ENV}}),
        files: new NodeCopiesFiles(tempRoot),
        hostSettings: () => ({instructions: '', copyConfig: true, baseFolder: options.baseFolder ?? '~/projects'}),
        home,
        clock: {now: () => Date.UTC(2026, 10, 3, 12, 0, 0)},
        timers,
        ids: {newId: () => crypto.randomUUID()},
        log: silentLog,
        maxUploadBytes: options.maxUploadBytes,
    });
    const pair = linkPair();
    const received: AgentMessage[] = [];
    pair.mac.onMessage((message) => received.push(message));
    pair.agent.onMessage((message) => part.handle(pair.agent, message as CopiesMessage));
    part.clientConnected(pair.agent);
    return {part, timers, received, pair, send: (message) => pair.mac.send(message)};
}

/** Wait for the agent's answer to `requestId`. */
async function answer<T extends AgentMessage['type']>(
    h: Harness,
    type: T,
    requestId: string,
): Promise<Extract<AgentMessage, {type: T}>> {
    const deadline = Date.now() + 30_000;
    for (;;) {
        const found = h.received.find(
            (m): m is Extract<AgentMessage, {type: T}> =>
                m.type === type && 'requestId' in m && m.requestId === requestId,
        );
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no ${type} for ${requestId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** Upload `bytes` in small chunks, as the Mac does a big file; resolves with `done`. */
async function upload(h: Harness, uploadId: string, bytes: Buffer, sha256?: string) {
    h.send({type: 'upload-begin', uploadId, size: bytes.length});
    for (let at = 0; at < bytes.length; at += 100) {
        h.send({type: 'upload-chunk', uploadId, dataBase64: bytes.subarray(at, at + 100).toString('base64')});
    }
    const requestId = `end-${uploadId}`;
    h.send({
        type: 'upload-end',
        requestId,
        uploadId,
        sha256: sha256 ?? crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    return answer(h, 'done', requestId);
}

let requests = 0;

/** Upload the Mac's bundle and patch, then hand off; resolves with `handoff-done`. */
async function handOff(h: Harness, mac: string, root: string, extra: Partial<HandoffMessage> = {}) {
    const payload = macPayload(mac, root);
    const n = ++requests;
    assert.equal((await upload(h, `bundle-${n}`, payload.bundle)).ok, true);
    assert.equal((await upload(h, `patch-${n}`, payload.patch)).ok, true);
    const requestId = `handoff-${n}`;
    h.send({
        type: 'handoff',
        requestId,
        repo: {name: 'proj', origin: path.join(root, 'origin.git')},
        branch: payload.branch,
        headOid: payload.headOid,
        bundleUploadId: `bundle-${n}`,
        patchUploadId: `patch-${n}`,
        files: [{path: '.env', contentBase64: Buffer.from('SECRET=1\n').toString('base64'), mode: 0o600}],
        ...extra,
    });
    return {done: await answer(h, 'handoff-done', requestId), payload, requestId};
}

const copyOf = (home: string) => path.join(home, 'projects', 'proj');

// ── Hand-off ──

test('a hand-off clones origin and lands the Mac commits, branch, working tree, files and marker', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);

    /* When */
    const {done, payload, requestId} = await handOff(h, w.mac, w.root);

    /* Then */
    assert.deepEqual(done, {type: 'handoff-done', requestId, ok: true, dir: '~/projects/proj', reused: false});
    const copy = copyOf(w.home);
    assert.equal(git(copy, ['rev-parse', 'HEAD']).trim(), payload.headOid);
    assert.equal(git(copy, ['symbolic-ref', '--short', 'HEAD']).trim(), 'feature');
    assert.equal(fs.readFileSync(path.join(copy, 'README.md'), 'utf8'), 'hello, edited\n');
    assert.equal(fs.readFileSync(path.join(copy, 'notes/new.txt'), 'utf8'), 'untracked\n');
    assert.deepEqual(fs.readFileSync(path.join(copy, 'logo.bin')), Buffer.from([0, 1, 2, 255, 0, 10, 13]));
    assert.equal(git(copy, ['diff', '--cached', '--name-only']), '', 'nothing is staged');
    assert.equal(fs.readFileSync(path.join(copy, '.env'), 'utf8'), 'SECRET=1\n');
    assert.equal(fs.statSync(path.join(copy, '.env')).mode & 0o777, 0o600);
    const marker = JSON.parse(fs.readFileSync(path.join(copy, '.git', COPY_MARKER), 'utf8'));
    assert.equal(marker.handedOffAt, '2026-11-03T12:00:00.000Z');
    assert.equal(marker.origin, w.origin);
    assert.equal(marker.state.head, payload.headOid);
    assert.match(marker.state.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(marker.state.files, [{path: '.env', blob: git(copy, ['hash-object', '.env']).trim()}]);
    assert.equal(git(copy, ['diff', '--cached', '--name-only']), '', 'the real index is untouched');
    assert.equal(git(copy, ['for-each-ref', 'refs/switchboard']), '', 'the bundle refs are cleaned up');
    const lines = h.received.filter((m) => m.type === 'handoff-progress').map((m) => m.line);
    assert.deepEqual(lines, [
        `Cloning ${w.origin} into ~/projects/proj`,
        'Fetching your unpushed commits',
        'Checking out feature',
        'Applying your uncommitted changes',
        'Writing 1 file',
        'Done',
    ]);
    assert.equal(h.part.uploadCount, 0, 'the uploads used are deleted');
});

test('a second hand-off reuses a copy the first one left dirty and ends at the Mac new state', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    await handOff(h, w.mac, w.root);
    git(w.mac, ['add', '-A']);
    git(w.mac, ['commit', '-q', '-m', 'more work']);
    write(path.join(w.mac, 'a.txt'), 'one, edited\n');
    write(path.join(w.mac, 'c.txt'), 'three\n');

    /* When */
    const {done, payload} = await handOff(h, w.mac, w.root);

    /* Then */
    assert.equal(done.ok, true, done.error ?? '');
    assert.equal(done.reused, true);
    const copy = copyOf(w.home);
    assert.equal(git(copy, ['rev-parse', 'HEAD']).trim(), payload.headOid);
    assert.equal(git(copy, ['log', '-1', '--format=%s']).trim(), 'more work');
    assert.equal(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), 'one, edited\n');
    assert.equal(fs.readFileSync(path.join(copy, 'c.txt'), 'utf8'), 'three\n');
    assert.deepEqual(parsePorcelainZ(git(copy, ['status', '--porcelain=v1', '-z'])).sort(), ['a.txt', 'c.txt']);
    assert.equal(fs.readFileSync(path.join(copy, '.env'), 'utf8'), 'SECRET=1\n');
});

test('a hand-off onto a copy edited on the VM since is refused, naming only the VM change', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    await handOff(h, w.mac, w.root);
    write(path.join(copyOf(w.home), 'vm-only.txt'), 'made on the VM\n');

    /* When */
    const {done} = await handOff(h, w.mac, w.root);

    /* Then */
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /^Checking the copy at ~\/projects\/proj failed: .*uncommitted changes/);
    assert.match(done.error ?? '', /vm-only\.txt/);
    assert.doesNotMatch(done.error ?? '', /README\.md/);
    assert.equal(fs.readFileSync(path.join(copyOf(w.home), 'vm-only.txt'), 'utf8'), 'made on the VM\n');
    assert.equal(fs.readFileSync(path.join(copyOf(w.home), 'README.md'), 'utf8'), 'hello, edited\n');
});

test('a hand-off onto a copy whose ticked file changed on the VM is refused, naming it', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    await handOff(h, w.mac, w.root);
    write(path.join(copyOf(w.home), '.env'), 'SECRET=changed-on-vm\n');

    /* When */
    const {done} = await handOff(h, w.mac, w.root);

    /* Then */
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /uncommitted changes of its own: \.env\./);
    assert.equal(fs.readFileSync(path.join(copyOf(w.home), '.env'), 'utf8'), 'SECRET=changed-on-vm\n');
});

test('a hand-off onto a dirty copy with no record of its own is refused', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    await handOff(h, w.mac, w.root);
    write(path.join(copyOf(w.home), '.git', COPY_MARKER), JSON.stringify({handedOffAt: 'x', origin: w.origin}));

    /* When */
    const {done} = await handOff(h, w.mac, w.root);

    /* Then */
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /uncommitted changes of its own: .*README\.md/);
});

test('a hand-off refuses to move a branch off commits only the copy has', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    await handOff(h, w.mac, w.root);
    const copy = copyOf(w.home);
    git(copy, ['add', '-A']);
    git(copy, ['commit', '-q', '-m', 'vm work']);

    /* When */
    const {done} = await handOff(h, w.mac, w.root, {patchUploadId: undefined});

    /* Then */
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /^Checking out feature failed: .*vm work/);
    assert.equal(git(copy, ['log', '-1', '--format=%s']).trim(), 'vm work');
});

test('a hand-off into a folder Switchboard did not make is refused and the folder left alone', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    const theirs = copyOf(w.home);
    git(w.root, ['init', '-q', theirs]);
    write(path.join(theirs, 'mine.txt'), 'keep\n');

    /* When */
    const {done} = await handOff(h, w.mac, w.root);

    /* Then */
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /not a copy Switchboard made/);
    assert.deepEqual(fs.readdirSync(theirs).sort(), ['.git', 'mine.txt']);
});

test('a failed clone names its step and git reason', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);

    /* When */
    h.send({
        type: 'handoff',
        requestId: 'r1',
        repo: {name: 'proj', origin: path.join(w.root, 'nowhere.git')},
        branch: 'main',
        headOid: 'a'.repeat(40),
        files: [],
    });
    const done = await answer(h, 'handoff-done', 'r1');

    /* Then */
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /^Cloning .*nowhere\.git into ~\/projects\/proj failed: .*nowhere\.git/s);
});

test('a hand-off with an unsafe folder name or file path is refused before anything runs', async () => {
    /* Given */
    const ran: string[] = [];
    const commands: CopyCommandRunner = {
        run: (command, args) => {
            ran.push([command, ...args].join(' '));
            return Promise.resolve({exitCode: 0, stdout: '', stderr: ''});
        },
    };
    const h = harness('/home/dev', {commands});
    const base = {repo: {name: 'proj', origin: 'https://x/y.git'}, branch: 'main', headOid: 'a'.repeat(40)};

    /* When */
    h.send({type: 'handoff', requestId: 'r1', ...base, repo: {name: '../etc', origin: 'o'}, files: []});
    h.send({
        type: 'handoff',
        requestId: 'r2',
        ...base,
        files: [{path: '.git/hooks/pre-commit', contentBase64: '', mode: 0o755}],
    });
    h.send({type: 'handoff', requestId: 'r3', ...base, branch: '--upload-pack=x', files: []});

    /* Then */
    assert.match((await answer(h, 'handoff-done', 'r1')).error ?? '', /not a folder name/);
    assert.match((await answer(h, 'handoff-done', 'r2')).error ?? '', /outside the repository: \.git\/hooks/);
    assert.match((await answer(h, 'handoff-done', 'r3')).error ?? '', /not a branch name/);
    assert.deepEqual(ran, []);
});

test('a GitHub repository is cloned with gh, with the VM own login', async () => {
    /* Given */
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gh-')));
    const ran: {line: string; cwd?: string; env?: Record<string, string>}[] = [];
    const commands: CopyCommandRunner = {
        run(command, args, {cwd, env}): Promise<CommandResult> {
            ran.push({line: [command, ...args].join(' '), cwd, env});
            // `rev-parse --verify` of origin/<branch>: no such branch on origin.
            const missing = args[0] === 'rev-parse' && args.includes('--verify');
            return Promise.resolve({exitCode: missing ? 1 : 0, stdout: '', stderr: ''});
        },
    };
    const h = harness(home, {commands});
    const abs = path.join(home, 'projects', 'switchboard');

    /* When */
    h.send({
        type: 'handoff',
        requestId: 'r1',
        repo: {name: 'switchboard', origin: 'git@github.com:JBlaak/switchboard.git', github: 'JBlaak/switchboard'},
        branch: 'main',
        headOid: 'b'.repeat(40),
        files: [],
    });
    const done = await answer(h, 'handoff-done', 'r1');

    /* Then */
    assert.deepEqual(done, {
        type: 'handoff-done',
        requestId: 'r1',
        ok: true,
        dir: '~/projects/switchboard',
        reused: false,
    });
    assert.equal(ran[0].line, `gh repo clone JBlaak/switchboard ${abs}`);
    assert.equal(ran[0].env?.GH_PROMPT_DISABLED, '1');
    assert.equal(ran[0].env?.GIT_TERMINAL_PROMPT, '0');
    assert.ok(ran.some((r) => r.line === `git checkout --no-track -B main ${'b'.repeat(40)}` && r.cwd === abs));
    assert.ok(fs.existsSync(path.join(abs, '.git', COPY_MARKER)));
});

// ── copy-status and push-branch ──

test('copy-status lists the unpushed commits and uncommitted paths', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    const {payload} = await handOff(h, w.mac, w.root);

    /* When */
    h.send({type: 'copy-status', requestId: 's1', dir: '~/projects/proj'});
    const state = await answer(h, 'copy-state', 's1');

    /* Then */
    assert.equal(state.ok, true, state.error ?? '');
    assert.equal(state.branch, 'feature');
    assert.equal(state.headOid, payload.headOid);
    assert.equal(state.upstream, null);
    assert.deepEqual(
        state.unpushed?.map((c) => c.subject),
        ['add b', 'add a'],
    );
    assert.equal(state.unpushed?.[0].oid, payload.headOid);
    assert.deepEqual([...(state.uncommitted ?? [])].sort(), ['README.md', 'logo.bin', 'notes/']);
});

test('push-branch pushes the copy branch to origin and sets its upstream', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    const {payload} = await handOff(h, w.mac, w.root);

    /* When */
    h.send({type: 'push-branch', requestId: 'p1', dir: '~/projects/proj', branch: 'feature'});
    const done = await answer(h, 'done', 'p1');

    /* Then */
    assert.deepEqual(done, {type: 'done', requestId: 'p1', ok: true});
    assert.equal(git(w.origin, ['rev-parse', 'refs/heads/feature']).trim(), payload.headOid);
    h.send({type: 'copy-status', requestId: 's1', dir: '~/projects/proj'});
    const state = await answer(h, 'copy-state', 's1');
    assert.equal(state.upstream, 'origin/feature');
    assert.deepEqual(state.unpushed, []);
});

test('a failed push answers with git reason', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    await handOff(h, w.mac, w.root);

    /* When */
    h.send({type: 'push-branch', requestId: 'p1', dir: '~/projects/proj', branch: 'no-such-branch'});
    const done = await answer(h, 'done', 'p1');

    /* Then */
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /^Pushing no-such-branch failed: .*no-such-branch/s);
});

// ── remove-copy ──

test('remove-copy removes a marked copy inside the base folder', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    await handOff(h, w.mac, w.root);

    /* When */
    h.send({type: 'remove-copy', requestId: 'x1', dir: '~/projects/proj'});
    const done = await answer(h, 'done', 'x1');

    /* Then */
    assert.deepEqual(done, {type: 'done', requestId: 'x1', ok: true});
    assert.equal(fs.existsSync(copyOf(w.home)), false);
    assert.equal(fs.existsSync(path.join(w.home, 'projects')), true);
});

test('remove-copy refuses a folder outside the base folder, one without the marker, and the base itself', async () => {
    /* Given */
    const w = world();
    const h = harness(w.home);
    const outside = path.join(w.home, 'elsewhere');
    write(path.join(outside, '.git', COPY_MARKER), '{}');
    const unmarked = path.join(w.home, 'projects', 'theirs');
    write(path.join(unmarked, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(w.home, 'projects', '.git', COPY_MARKER), '{}');
    fs.symlinkSync(outside, path.join(w.home, 'projects', 'sneaky'));

    /* When */
    h.send({type: 'remove-copy', requestId: 'x1', dir: '~/elsewhere'});
    h.send({type: 'remove-copy', requestId: 'x2', dir: '~/projects/theirs'});
    h.send({type: 'remove-copy', requestId: 'x3', dir: '~/projects'});
    h.send({type: 'remove-copy', requestId: 'x4', dir: '~/projects/sneaky'});
    h.send({type: 'remove-copy', requestId: 'x5', dir: '~/projects/../elsewhere'});

    /* Then */
    assert.match((await answer(h, 'done', 'x1')).error ?? '', /not inside the base folder/);
    assert.match((await answer(h, 'done', 'x2')).error ?? '', /not a copy Switchboard made/);
    assert.match((await answer(h, 'done', 'x3')).error ?? '', /not inside the base folder/);
    assert.match((await answer(h, 'done', 'x4')).error ?? '', /not inside the base folder/);
    assert.match((await answer(h, 'done', 'x5')).error ?? '', /not inside the base folder/);
    assert.ok(fs.existsSync(outside));
    assert.ok(fs.existsSync(unmarked));
});

// ── Uploads ──

test('an upload is checked against its SHA-256', async () => {
    /* Given */
    const h = harness('/home/dev');
    const bytes = Buffer.from('a bundle, say');

    /* When */
    const good = await upload(h, 'u1', bytes);
    const bad = await upload(h, 'u2', bytes, 'f'.repeat(64));

    /* Then */
    assert.deepEqual(good, {type: 'done', requestId: 'end-u1', ok: true});
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /does not match its SHA-256/);
});

test('an upload goes to a private folder', async () => {
    /* Given */
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-uploads-'));
    const h = harness('/home/dev', {tempRoot});

    /* When */
    await upload(h, 'u1', Buffer.from('x'));

    /* Then */
    const [folder] = fs.readdirSync(tempRoot);
    assert.equal(fs.statSync(path.join(tempRoot, folder)).mode & 0o777, 0o700);
    const [file] = fs.readdirSync(path.join(tempRoot, folder));
    assert.equal(fs.statSync(path.join(tempRoot, folder, file)).mode & 0o777, 0o600);
});

test('an upload that sends more than it announced, or is too big, is refused at its end', async () => {
    /* Given */
    const h = harness('/home/dev', {maxUploadBytes: 10});

    /* When */
    h.send({type: 'upload-begin', uploadId: 'u1', size: 2});
    h.send({type: 'upload-chunk', uploadId: 'u1', dataBase64: Buffer.from('abc').toString('base64')});
    h.send({type: 'upload-end', requestId: 'e1', uploadId: 'u1', sha256: '0'.repeat(64)});
    h.send({type: 'upload-begin', uploadId: 'u2', size: 11});
    h.send({type: 'upload-end', requestId: 'e2', uploadId: 'u2', sha256: '0'.repeat(64)});

    /* Then */
    assert.match((await answer(h, 'done', 'e1')).error ?? '', /larger than the 2 bytes it announced/);
    assert.match((await answer(h, 'done', 'e2')).error ?? '', /the most the agent takes is 10/);
});

test('an unknown upload, or a chunk after the end, is an error', async () => {
    /* Given */
    const h = harness('/home/dev');
    await upload(h, 'u1', Buffer.from('ab'));

    /* When */
    h.send({type: 'upload-end', requestId: 'e1', uploadId: 'nope', sha256: '0'.repeat(64)});
    h.send({type: 'upload-chunk', uploadId: 'u1', dataBase64: Buffer.from('c').toString('base64')});
    h.send({
        type: 'handoff',
        requestId: 'r1',
        repo: {name: 'p', origin: 'o'},
        branch: 'main',
        headOid: 'a'.repeat(40),
        bundleUploadId: 'u1',
        files: [],
    });

    /* Then */
    assert.match((await answer(h, 'done', 'e1')).error ?? '', /unknown upload nope/);
    assert.match((await answer(h, 'handoff-done', 'r1')).error ?? '', /got data after it ended/);
});

test('an unused upload expires, and a hand-off naming it then fails', async () => {
    /* Given */
    const h = harness('/home/dev');
    await upload(h, 'u1', Buffer.from('ab'));

    /* When */
    h.timers.tick();
    h.send({
        type: 'handoff',
        requestId: 'r1',
        repo: {name: 'p', origin: 'o'},
        branch: 'main',
        headOid: 'a'.repeat(40),
        bundleUploadId: 'u1',
        files: [],
    });

    /* Then */
    assert.equal(h.part.uploadCount, 0);
    assert.match((await answer(h, 'handoff-done', 'r1')).error ?? '', /unknown upload u1/);
});

test('a client that goes away loses its unfinished uploads but not its finished ones', async () => {
    /* Given */
    const h = harness('/home/dev');
    await upload(h, 'done-one', Buffer.from('ab'));
    h.send({type: 'upload-begin', uploadId: 'half', size: 4});
    h.send({type: 'upload-chunk', uploadId: 'half', dataBase64: Buffer.from('ab').toString('base64')});

    /* When */
    h.part.clientGone(h.pair.agent);

    /* Then */
    assert.equal(h.part.uploadCount, 1);
});

// ── Rules ──

test('porcelain -z output gives every path once, renames by their new name', () => {
    /* Given */
    const stdout = ' M README.md\0R  new.txt\0old.txt\0?? notes/\0';

    /* When */
    const paths = parsePorcelainZ(stdout);

    /* Then */
    assert.deepEqual(paths, ['README.md', 'new.txt', 'notes/']);
});

test('branch names that git refuses or that read as options are not plausible', () => {
    /* Then */
    for (const ok of ['main', 'feature/x', 'agent/copies-agent', 'v1.2']) assert.equal(isPlausibleBranch(ok), true, ok);
    for (const bad of ['', '-x', 'a..b', 'a b', 'a~1', 'x.lock', '.hidden', 'a/', 'HEAD', '@{-1}']) {
        assert.equal(isPlausibleBranch(bad), false, bad);
    }
});

test('a copy folder is one safe segment under the base folder, ~ kept', () => {
    /* Then */
    assert.equal(joinDir('~/projects/', 'proj'), '~/projects/proj');
    assert.equal(isSafeFolderName('proj'), true);
    for (const bad of ['', '.', '..', 'a/b', '.git', '-rf']) assert.equal(isSafeFolderName(bad), false, bad);
});
