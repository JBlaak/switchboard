import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {Tools, type ToolRun, type ToolRunner, type ToolRunOptions} from '../src/application/services/agent-host/tools';
import type {QueryableTranscripts} from '../src/application/services/agent-host/tools-transcripts';
import type {TreeWatcher} from '../src/application/services/agent-host/tools-watches';
import type {ToolsMessage} from '../src/application/services/agent-host/handlers';
import type {AgentMessage} from '../src/domain/agent/protocol';
import {parseMacMessage} from '../src/domain/agent/validate';
import {encodeProjectPath} from '../src/domain/project/project-path';
import {NodeGitTreeWatcher} from '../src/infrastructure/agent/node-git-tree-watcher';
import {NodeToolRunner} from '../src/infrastructure/agent/node-tool-runner';
import {NodeWorkingFiles} from '../src/infrastructure/agent/node-working-files';
import {NodeFileSystem} from '../src/infrastructure/fs/node-file-system';
import {FileTranscriptStore} from '../src/infrastructure/fs/transcript-store';
import {systemTimers} from '../src/infrastructure/system/timers';
import {linkPair} from './support/agent-link';
import {silentLog} from './support/fakes';

/**
 * The agent's tools part (#296), driven through an in-memory link against
 * real git in temp folders, real files, a real `~/.claude/projects` and the
 * real watcher. Timers are real, with the debounce and poll made short.
 */

const SESSION = '11111111-2222-4333-8444-555555555555';

/** A temp folder with every symlink resolved (macOS's `/var` is one). */
function tempDir(prefix: string): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@t',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@t',
        },
    });
}

/** A repository with one commit holding `a.txt` and a binary `img.png`. */
function repo(): string {
    const dir = tempDir('sb-tools-repo-');
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    fs.writeFileSync(path.join(dir, 'img.png'), PNG);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    return dir;
}

/** Bytes that no text decoding survives: NUL, 0xff, a lone continuation byte. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x01]);

/** A folder with a fake `gh` that prints where and how it ran, or sleeps when asked to. */
function fakeGhBin(): string {
    const bin = tempDir('sb-tools-bin-');
    const gh = path.join(bin, 'gh');
    fs.writeFileSync(
        gh,
        '#!/bin/sh\nif [ "$1" = sleep ]; then exec sleep 5; fi\necho "cwd=$(pwd) args=$* prompt=$GH_PROMPT_DISABLED"\n',
    );
    fs.chmodSync(gh, 0o755);
    return bin;
}

interface Harness {
    part: Tools;
    home: string;
    projects: string;
    received: AgentMessage[];
    pair: ReturnType<typeof linkPair>;
    send(message: ToolsMessage): void;
    /** The first message matching `match`, waiting for it up to `ms`. */
    next<T extends AgentMessage>(match: (m: AgentMessage) => m is T, ms?: number): Promise<T>;
    /** Whether a message matching `match` arrives within `ms`. */
    arrives(match: (m: AgentMessage) => boolean, ms: number): Promise<boolean>;
}

function harness(
    options: {
        runner?: ToolRunner;
        watcher?: TreeWatcher;
        transcripts?: QueryableTranscripts;
        outputCapBytes?: number;
        maxRunsPerClient?: number;
    } = {},
): Harness {
    const home = tempDir('sb-tools-home-');
    const projects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(projects, {recursive: true});
    const bin = fakeGhBin();
    const part = new Tools({
        runner: options.runner ?? new NodeToolRunner({env: {...process.env, PATH: `${bin}:${process.env.PATH}`}}),
        files: new NodeWorkingFiles(),
        watcher: options.watcher ?? new NodeGitTreeWatcher(),
        transcripts: options.transcripts ?? new FileTranscriptStore(new NodeFileSystem(), projects),
        home,
        timers: systemTimers,
        log: silentLog,
        outputCapBytes: options.outputCapBytes,
        maxRunsPerClient: options.maxRunsPerClient,
        watchDebounceMs: 50,
        watchPollMs: 50,
    });
    const pair = linkPair();
    const received: AgentMessage[] = [];
    const waiters = new Set<(m: AgentMessage) => void>();
    pair.mac.onMessage((message) => {
        received.push(message);
        for (const waiter of [...waiters]) waiter(message);
    });
    const arrives = (match: (m: AgentMessage) => boolean, ms: number) =>
        new Promise<AgentMessage | null>((resolve) => {
            const found = received.find(match);
            if (found) return resolve(found);
            const timer = setTimeout(() => {
                waiters.delete(waiter);
                resolve(null);
            }, ms);
            const waiter = (m: AgentMessage) => {
                if (!match(m)) return;
                clearTimeout(timer);
                waiters.delete(waiter);
                resolve(m);
            };
            waiters.add(waiter);
        });
    return {
        part,
        home,
        projects,
        received,
        pair,
        send: (message) => part.handle(pair.agent, message),
        async next<T extends AgentMessage>(match: (m: AgentMessage) => m is T, ms = 10_000): Promise<T> {
            const found = await arrives(match, ms);
            if (!found) throw new Error('no matching message arrived');
            return found as T;
        },
        arrives: async (match, ms) => (await arrives(match, ms)) !== null,
    };
}

type ToolResult = Extract<AgentMessage, {type: 'tool-result'}>;
type FileContent = Extract<AgentMessage, {type: 'file-content'}>;
type FileStats = Extract<AgentMessage, {type: 'file-stats'}>;
type TranscriptAnswer = Extract<AgentMessage, {type: 'transcript-answer'}>;

const toolResult =
    (requestId: string) =>
    (m: AgentMessage): m is ToolResult =>
        m.type === 'tool-result' && m.requestId === requestId;
const fileContent =
    (requestId: string) =>
    (m: AgentMessage): m is FileContent =>
        m.type === 'file-content' && m.requestId === requestId;
const fileStats =
    (requestId: string) =>
    (m: AgentMessage): m is FileStats =>
        m.type === 'file-stats' && m.requestId === requestId;
const transcriptAnswer =
    (requestId: string) =>
    (m: AgentMessage): m is TranscriptAnswer =>
        m.type === 'transcript-answer' && m.requestId === requestId;
const dirChanged = (watchId: string) => (m: AgentMessage) => m.type === 'dir-changed' && m.watchId === watchId;

function runTool(
    h: Harness,
    requestId: string,
    tool: 'git' | 'gh',
    cwd: string,
    args: string[],
    extra: {stdinBase64?: string; timeoutMs?: number} = {},
): void {
    h.send({type: 'run-tool', requestId, tool, cwd, args, timeoutMs: extra.timeoutMs ?? 30_000, ...extra});
}

// ── run-tool ──

test('a git run answers its exit code and stdout', async () => {
    /* Given */
    const h = harness();
    const dir = repo();

    /* When */
    runTool(h, 'r1', 'git', dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const result = await h.next(toolResult('r1'));

    /* Then */
    assert.equal(result.code, 0);
    assert.equal(Buffer.from(result.stdoutBase64, 'base64').toString('utf8'), 'main\n');
    assert.equal(result.truncated, undefined);
});

test('git stdout is binary-safe: a committed image comes back byte for byte', async () => {
    /* Given */
    const h = harness();
    const dir = repo();

    /* When */
    runTool(h, 'r1', 'git', dir, ['show', 'HEAD:img.png']);
    const result = await h.next(toolResult('r1'));

    /* Then */
    assert.equal(result.code, 0);
    assert.deepEqual(Buffer.from(result.stdoutBase64, 'base64'), PNG);
});

test('a failing git run answers its own exit code and the tail of stderr', async () => {
    /* Given */
    const h = harness();
    const dir = repo();

    /* When */
    runTool(h, 'r1', 'git', dir, ['rev-parse', '--verify', 'no-such-branch']);
    const result = await h.next(toolResult('r1'));

    /* Then */
    assert.notEqual(result.code, 0);
    assert.notEqual(result.code, -1);
    assert.match(result.stderr, /no-such-branch|Needed a single revision/);
});

test('stdin is passed to the tool', async () => {
    /* Given */
    const h = harness();
    const dir = repo();

    /* When */
    runTool(h, 'r1', 'git', dir, ['hash-object', '--stdin'], {
        stdinBase64: Buffer.from('hello\n').toString('base64'),
    });
    const result = await h.next(toolResult('r1'));

    /* Then */
    assert.equal(result.code, 0);
    assert.equal(
        Buffer.from(result.stdoutBase64, 'base64').toString('utf8').trim(),
        'ce013625030ba8dba906f756967f9e9ca394464a',
    );
});

test('a run past its timeout is killed and answers code -1', async () => {
    /* Given */
    const h = harness();
    const dir = repo();
    const started = Date.now();

    /* When */
    runTool(h, 'r1', 'gh', dir, ['sleep'], {timeoutMs: 200});
    const result = await h.next(toolResult('r1'));

    /* Then */
    assert.equal(result.code, -1);
    assert.match(result.stderr, /timed out/);
    assert.ok(Date.now() - started < 4000, 'answered without waiting for the sleep');
});

test('stdout past the cap is cut and marked truncated, with the real exit code', async () => {
    /* Given */
    const h = harness({outputCapBytes: 4});
    const dir = repo();

    /* When */
    runTool(h, 'r1', 'git', dir, ['show', 'HEAD:a.txt']);
    const result = await h.next(toolResult('r1'));

    /* Then */
    assert.equal(result.code, 0);
    assert.equal(Buffer.from(result.stdoutBase64, 'base64').toString('utf8'), 'hell');
    assert.equal(result.truncated, true);
});

test('a relative cwd is refused without running anything', async () => {
    /* Given */
    const h = harness();

    /* When */
    runTool(h, 'r1', 'git', 'projects/site', ['status']);
    const result = await h.next(toolResult('r1'));

    /* Then */
    assert.equal(result.code, -1);
    assert.match(result.stderr, /absolute/);
});

test('gh runs in the cwd with prompts disabled', async () => {
    /* Given */
    const h = harness();
    const dir = repo();

    /* When */
    runTool(h, 'r1', 'gh', dir, ['pr', 'list', '--json', 'number']);
    const result = await h.next(toolResult('r1'));

    /* Then */
    assert.equal(result.code, 0);
    assert.equal(
        Buffer.from(result.stdoutBase64, 'base64').toString('utf8').trim(),
        `cwd=${dir} args=pr list --json number prompt=1`,
    );
});

/** A runner whose runs finish only when the test says, recording what ran. */
function heldRunner(): ToolRunner & {started: string[]; release(): void; signals: AbortSignal[]} {
    const pending: (() => void)[] = [];
    const started: string[] = [];
    const signals: AbortSignal[] = [];
    return {
        started,
        signals,
        run(_command: string, args: readonly string[], options: ToolRunOptions): Promise<ToolRun> {
            started.push(args[args.length - 1]);
            if (options.signal) signals.push(options.signal);
            return new Promise((resolve) =>
                pending.push(() => resolve({code: 0, stdout: new Uint8Array(), truncated: false, stderr: ''})),
            );
        },
        release() {
            for (const done of pending.splice(0)) done();
        },
    };
}

test('runs past the per-client limit wait their turn', async () => {
    /* Given */
    const runner = heldRunner();
    const h = harness({runner, maxRunsPerClient: 2});
    for (const id of ['a', 'b', 'c']) runTool(h, id, 'git', '/srv', ['log', id]);

    /* When */
    const before = [...runner.started];
    runner.release();
    await h.next(toolResult('b'));
    await new Promise((resolve) => setImmediate(resolve));

    /* Then */
    assert.deepEqual(before, ['a', 'b']);
    assert.deepEqual(runner.started, ['a', 'b', 'c']);
});

test('a client going kills its running tools and drops its queue', () => {
    /* Given */
    const runner = heldRunner();
    const h = harness({runner, maxRunsPerClient: 1});
    runTool(h, 'a', 'git', '/srv', ['log', 'a']);
    runTool(h, 'b', 'git', '/srv', ['log', 'b']);

    /* When */
    h.part.clientGone(h.pair.agent);

    /* Then */
    assert.equal(runner.signals[0].aborted, true);
    assert.deepEqual(runner.started, ['a']);
});

// ── read-file and stat-files ──

test('read-file answers a regular file’s bytes', async () => {
    /* Given */
    const h = harness();
    const dir = repo();

    /* When */
    h.send({type: 'read-file', requestId: 'f1', path: path.join(dir, 'img.png'), maxBytes: 1024});
    const answer = await h.next(fileContent('f1'));

    /* Then */
    assert.equal(answer.found, true);
    assert.deepEqual(Buffer.from(answer.contentBase64 ?? '', 'base64'), PNG);
});

test('read-file refuses a symlink, a file under a symlinked folder, a folder, a .. path and a file past maxBytes', async () => {
    /* Given */
    const h = harness();
    const dir = repo();
    fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'link.txt'));
    fs.symlinkSync(dir, path.join(h.home, 'via'));
    const asks = {
        link: path.join(dir, 'link.txt'),
        throughFolder: path.join(h.home, 'via', 'a.txt'),
        folder: dir,
        tooBig: path.join(dir, 'a.txt'),
        relative: 'a.txt',
        dotDot: `${dir}/x/../a.txt`,
    };

    /* When */
    for (const [id, file] of Object.entries(asks)) {
        h.send({type: 'read-file', requestId: id, path: file, maxBytes: id === 'tooBig' ? 3 : 1024});
    }
    const answers = await Promise.all(Object.keys(asks).map((id) => h.next(fileContent(id))));

    /* Then */
    assert.deepEqual(
        answers.map((a) => a.found),
        answers.map(() => false),
    );
});

test('stat-files answers the sizes of regular files and leaves the rest out', async () => {
    /* Given */
    const h = harness();
    const dir = repo();
    fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'link.txt'));
    const paths = [
        path.join(dir, 'a.txt'),
        path.join(dir, 'img.png'),
        path.join(dir, 'link.txt'),
        dir,
        path.join(dir, 'missing'),
    ];

    /* When */
    h.send({type: 'stat-files', requestId: 's1', paths});
    const answer = await h.next(fileStats('s1'));

    /* Then */
    assert.deepEqual(answer.sizes, {[path.join(dir, 'a.txt')]: 6, [path.join(dir, 'img.png')]: PNG.length});
});

// ── watch-dir ──

test('a watch pushes dir-changed after the index moves', async () => {
    /* Given */
    const h = harness();
    const dir = repo();
    h.send({type: 'watch-dir', watchId: 'w1', dir});
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');

    /* When */
    git(dir, 'add', 'a.txt');

    /* Then */
    assert.equal(await h.arrives(dirChanged('w1'), 5000), true);
});

test('a watch stops on unwatch-dir', async () => {
    /* Given */
    const h = harness();
    const dir = repo();
    h.send({type: 'watch-dir', watchId: 'w1', dir});
    h.send({type: 'unwatch-dir', watchId: 'w1'});

    /* When */
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    git(dir, 'commit', '-qam', 'second');

    /* Then */
    assert.equal(await h.arrives(dirChanged('w1'), 600), false);
    assert.equal(h.part.watchCount, 0);
});

test('a watch stops when its client goes', async () => {
    /* Given */
    const h = harness();
    const dir = repo();
    h.send({type: 'watch-dir', watchId: 'w1', dir});
    h.part.clientGone(h.pair.agent);

    /* When */
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    git(dir, 'commit', '-qam', 'second');

    /* Then */
    assert.equal(await h.arrives(dirChanged('w1'), 600), false);
    assert.equal(h.part.watchCount, 0);
});

test('a tree that cannot be watched is polled with git status', async () => {
    /* Given */
    const h = harness({watcher: {watch: () => null}});
    const dir = repo();
    h.send({type: 'watch-dir', watchId: 'w1', dir});
    await new Promise((resolve) => setTimeout(resolve, 200));

    /* When */
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');

    /* Then */
    assert.equal(await h.arrives(dirChanged('w1'), 5000), true);
    h.part.clientGone(h.pair.agent);
});

// ── transcript-query ──

/** A transcript for SESSION, written from `cwd` on `branch`, in its project's folder. */
function fixtureTranscript(projects: string, cwd: string, branch: string): string {
    const folder = encodeProjectPath(cwd);
    fs.mkdirSync(path.join(projects, folder), {recursive: true});
    const line = (type: 'user' | 'assistant', text: string, timestamp: string) =>
        JSON.stringify({
            type,
            cwd,
            gitBranch: branch,
            sessionId: SESSION,
            entrypoint: 'cli',
            timestamp,
            message:
                type === 'user' ? {role: 'user', content: text} : {role: 'assistant', content: [{type: 'text', text}]},
        });
    fs.writeFileSync(
        path.join(projects, folder, `${SESSION}.jsonl`),
        [
            line('user', 'Fix #12 please', '2026-11-01T10:00:00.000Z'),
            line('assistant', 'On it.', '2026-11-01T10:00:05.000Z'),
        ].join('\n') + '\n',
    );
    return folder;
}

test('transcript-query locations answers where the session was written from', async () => {
    /* Given */
    const h = harness();
    const folder = fixtureTranscript(h.projects, '/home/dev/projects/site', 'feature/x');

    /* When */
    h.send({type: 'transcript-query', requestId: 'q1', method: 'locations', args: [folder, SESSION]});
    const answer = await h.next(transcriptAnswer('q1'));

    /* Then */
    assert.deepEqual(answer, {
        type: 'transcript-answer',
        requestId: 'q1',
        ok: true,
        result: [{cwd: '/home/dev/projects/site', branch: 'feature/x', fromSubagent: false}],
    });
});

test('transcript-query readSession answers the parsed session as JSON', async () => {
    /* Given */
    const h = harness();
    const folder = fixtureTranscript(h.projects, '/home/dev/projects/site', 'main');

    /* When */
    h.send({
        type: 'transcript-query',
        requestId: 'q1',
        method: 'readSession',
        args: [folder, SESSION, '/home/dev/projects/site'],
    });
    const answer = await h.next(transcriptAnswer('q1'));

    /* Then */
    assert.equal(answer.ok, true);
    const session = answer.result as {sessionId: string; folder: string; projectPath: string; firstPrompt: string};
    assert.equal(session.sessionId, SESSION);
    assert.equal(session.folder, folder);
    assert.equal(session.projectPath, '/home/dev/projects/site');
    assert.match(session.firstPrompt, /Fix #12/);
});

test('transcript-query answers null for a session with no transcript', async () => {
    /* When */
    const h = harness();
    h.send({type: 'transcript-query', requestId: 'q1', method: 'sessionMtimeMs', args: ['-nowhere', SESSION]});
    const answer = await h.next(transcriptAnswer('q1'));

    /* Then */
    assert.deepEqual(answer, {type: 'transcript-answer', requestId: 'q1', ok: true, result: null});
});

test('a method outside the read methods is refused by the validator', () => {
    /* When */
    const parsed = parseMacMessage({type: 'transcript-query', requestId: 'q1', method: 'seedSession', args: []});

    /* Then */
    assert.equal(parsed.ok, false);
});

test('transcript-query refuses arguments of the wrong kind, and a folder that leaves the projects folder', async () => {
    /* Given */
    const h = harness();

    /* When */
    h.send({type: 'transcript-query', requestId: 'q1', method: 'readTail', args: ['-a', SESSION, 'lots']});
    h.send({type: 'transcript-query', requestId: 'q2', method: 'locations', args: ['..', SESSION]});
    h.send({type: 'transcript-query', requestId: 'q3', method: 'locations', args: ['-a']});
    const answers = await Promise.all(['q1', 'q2', 'q3'].map((id) => h.next(transcriptAnswer(id))));

    /* Then */
    assert.deepEqual(
        answers.map((a) => a.ok),
        [false, false, false],
    );
});

test('a store call that throws is answered ok:false with its message', async () => {
    /* Given */
    const throwing = new Proxy({} as QueryableTranscripts, {
        get: () => () => {
            throw new Error('disk on fire');
        },
    });
    const h = harness({transcripts: throwing});

    /* When */
    h.send({type: 'transcript-query', requestId: 'q1', method: 'resolveProjectPath', args: ['-a']});
    const answer = await h.next(transcriptAnswer('q1'));

    /* Then */
    assert.deepEqual(answer, {type: 'transcript-answer', requestId: 'q1', ok: false, error: 'disk on fire'});
});
