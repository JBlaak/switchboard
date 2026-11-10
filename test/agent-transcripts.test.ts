import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {Uploads} from '../src/application/services/agent-host/copies-uploads';
import {
    CWD_HEAD_BYTES,
    LIST_MAX_SESSIONS,
    TAIL_MAX_BYTES,
    Transcripts,
    type FolderWatch,
    type FolderWatcher,
} from '../src/application/services/agent-host/transcripts';
import type {TranscriptsMessage} from '../src/application/services/agent-host/handlers';
import type {AgentMessage} from '../src/domain/agent/protocol';
import {encodeProjectPath} from '../src/domain/project/project-path';
import {NodeCopiesFiles} from '../src/infrastructure/agent/node-copies-files';
import {NodeFolderWatcher} from '../src/infrastructure/agent/node-folder-watcher';
import {NodeTranscriptFiles} from '../src/infrastructure/agent/node-transcript-files';
import {linkPair} from './support/agent-link';
import {fakeTimers, silentLog, type FakeTimers} from './support/fakes';

/**
 * The agent's transcripts part (#290), driven through an in-memory link
 * against a real `~/.claude/projects` in a temp folder. The folder watcher is
 * faked so a test says when inotify would fire, and the timers are fake so the
 * debounce and the polling go a round at a time.
 */

const SESSION = '11111111-2222-4333-8444-555555555555';

function user(text: string, timestamp: string, cwd: string): string {
    return JSON.stringify({
        type: 'user',
        cwd,
        sessionId: SESSION,
        entrypoint: 'cli',
        timestamp,
        message: {role: 'user', content: text},
    });
}

function assistant(text: string, timestamp: string, cwd: string): string {
    return JSON.stringify({
        type: 'assistant',
        cwd,
        sessionId: SESSION,
        timestamp,
        message: {role: 'assistant', content: [{type: 'text', text}]},
    });
}

function prLink(n: number, timestamp: string): string {
    return JSON.stringify({
        type: 'pr-link',
        sessionId: SESSION,
        prNumber: n,
        prUrl: `https://github.com/owner/repo/pull/${n}`,
        prRepository: 'owner/repo',
        timestamp,
    });
}

/** A watcher the test fires by hand, recording what is watched. */
interface FakeWatcher extends FolderWatcher {
    readonly open: Set<string>;
    fire(folder: string): void;
}

function fakeWatcher(): FakeWatcher {
    const listeners = new Map<string, () => void>();
    const open = new Set<string>();
    return {
        open,
        watch(folder, onChange): FolderWatch {
            open.add(folder);
            listeners.set(folder, onChange);
            return {
                close() {
                    open.delete(folder);
                    listeners.delete(folder);
                },
            };
        },
        fire(folder) {
            listeners.get(folder)?.();
        },
    };
}

interface Harness {
    part: Transcripts;
    home: string;
    projects: string;
    timers: FakeTimers;
    watcher: FakeWatcher;
    uploads: Uploads;
    received: AgentMessage[];
    pair: ReturnType<typeof linkPair>;
    send(message: TranscriptsMessage): void;
    /** A second client on its own link, as another Mac would be. */
    second(): {pair: ReturnType<typeof linkPair>; received: AgentMessage[]};
}

function harness(options: {textCapChars?: number} = {}): Harness {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-transcripts-')));
    const home = path.join(root, 'home');
    const projects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(projects, {recursive: true});
    const timers = fakeTimers();
    const watcher = fakeWatcher();
    const uploads = new Uploads({
        files: new NodeCopiesFiles(fs.mkdtempSync(path.join(root, 'tmp-'))),
        timers,
        ids: {newId: () => crypto.randomUUID()},
        log: silentLog,
    });
    const part = new Transcripts({
        files: new NodeTranscriptFiles(),
        watcher,
        uploads,
        home,
        projectsDir: projects,
        timers,
        log: silentLog,
        textCapChars: options.textCapChars,
    });
    const connect = () => {
        const pair = linkPair();
        const received: AgentMessage[] = [];
        pair.mac.onMessage((message) => received.push(message));
        pair.agent.onMessage((message) => part.handle(pair.agent, message as TranscriptsMessage));
        pair.agent.onClose(() => part.clientGone(pair.agent));
        part.clientConnected(pair.agent);
        return {pair, received};
    };
    const first = connect();
    return {
        part,
        home,
        projects,
        timers,
        watcher,
        uploads,
        received: first.received,
        pair: first.pair,
        send: (message) => first.pair.mac.send(message),
        second: connect,
    };
}

/** Write a transcript into a project folder; its absolute path. */
function writeTranscript(h: Harness, folder: string, lines: string[], sessionId = SESSION): string {
    const dir = path.join(h.projects, folder);
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
}

function reply<T extends AgentMessage['type']>(
    received: AgentMessage[],
    type: T,
    requestId: string,
): Extract<AgentMessage, {type: T}> {
    const found = received.find(
        (m): m is Extract<AgentMessage, {type: T}> => m.type === type && 'requestId' in m && m.requestId === requestId,
    );
    assert.ok(found, `no ${type} for ${requestId}`);
    return found;
}

function changes(received: AgentMessage[]): string[][] {
    return received.flatMap((m) => (m.type === 'transcripts-changed' ? [m.sessionIds] : []));
}

/** Upload `bytes` the way the Mac does; the upload's id. */
async function upload(h: Harness, bytes: Buffer): Promise<string> {
    const uploadId = crypto.randomUUID();
    h.uploads.begin(h.pair.agent, {type: 'upload-begin', uploadId, size: bytes.length});
    h.uploads.chunk({type: 'upload-chunk', uploadId, dataBase64: bytes.toString('base64')});
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await h.uploads.end(h.pair.agent, {type: 'upload-end', requestId: `end-${uploadId}`, uploadId, sha256});
    return uploadId;
}

// ── get-transcript ──

test('a transcript is parsed with its summary, PR links and cwd', () => {
    /* Given */
    const h = harness();
    const cwd = '/home/joris/projects/switchboard';
    writeTranscript(h, encodeProjectPath(cwd), [
        user('Fix the flaky socket test', '2026-11-01T10:00:00.000Z', cwd),
        assistant('On it.', '2026-11-01T10:00:05.000Z', cwd),
        prLink(42, '2026-11-01T10:30:00.000Z'),
    ]);

    /* When */
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});

    /* Then */
    const {transcript} = reply(h.received, 'transcript', 'r1');
    assert.ok(transcript);
    assert.equal(transcript.cwd, cwd);
    assert.equal(transcript.session.sessionId, SESSION);
    assert.equal(transcript.session.folder, encodeProjectPath(cwd));
    assert.equal(transcript.session.projectPath, cwd);
    assert.equal(transcript.session.summary, 'Fix the flaky socket test');
    assert.equal(transcript.session.messageCount, 2);
    assert.equal(transcript.session.created, '2026-11-01T10:00:00.000Z');
    assert.deepEqual(transcript.session.pullRequests, [
        {number: 42, url: 'https://github.com/owner/repo/pull/42', repository: 'owner/repo'},
    ]);
    assert.ok(transcript.mtimeMs > 0);
});

test("a transcript's text is capped for the Mac's search index", () => {
    /* Given */
    const h = harness({textCapChars: 10});
    const cwd = '/home/joris/projects/switchboard';
    writeTranscript(h, encodeProjectPath(cwd), [user('a long first message', '2026-11-01T10:00:00.000Z', cwd)]);

    /* When */
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});

    /* Then */
    const {transcript} = reply(h.received, 'transcript', 'r1');
    assert.equal(transcript?.session.textContent, 'a long fir');
});

test('the newest of two files of one session is the one read', () => {
    /* Given */
    const h = harness();
    const older = writeTranscript(h, '-old', [user('old place', '2026-11-01T10:00:00.000Z', '/old')]);
    writeTranscript(h, '-new', [user('new place', '2026-11-02T10:00:00.000Z', '/new')]);
    fs.utimesSync(older, new Date('2026-01-01'), new Date('2026-01-01'));

    /* When */
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});

    /* Then */
    assert.equal(reply(h.received, 'transcript', 'r1').transcript?.cwd, '/new');
});

test('an unknown id, or one that is not an id, answers null', () => {
    /* Given */
    const h = harness();

    /* When */
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});
    h.send({type: 'get-transcript', requestId: 'r2', sessionId: '../../etc/passwd'});

    /* Then */
    assert.equal(reply(h.received, 'transcript', 'r1').transcript, null);
    assert.equal(reply(h.received, 'transcript', 'r2').transcript, null);
    assert.deepEqual(h.part.watchedIds, [SESSION]);
});

// ── watching ──

test('a change pushes transcripts-changed once, after the debounce', () => {
    /* Given */
    const h = harness();
    const cwd = '/home/joris/projects/switchboard';
    const folder = encodeProjectPath(cwd);
    const file = writeTranscript(h, folder, [user('hi', '2026-11-01T10:00:00.000Z', cwd)]);
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});
    assert.ok(h.watcher.open.has(path.join(h.projects, folder)));

    /* When */
    fs.appendFileSync(file, assistant('one', '2026-11-01T10:00:01.000Z', cwd) + '\n');
    h.watcher.fire(path.join(h.projects, folder));
    fs.appendFileSync(file, assistant('two', '2026-11-01T10:00:02.000Z', cwd) + '\n');
    h.watcher.fire(path.join(h.projects, folder));
    const beforeDebounce = changes(h.received);
    h.timers.tick();
    h.timers.tick();

    /* Then */
    assert.deepEqual(beforeDebounce, []);
    assert.deepEqual(changes(h.received), [[SESSION]]);
});

test('a folder event for another file pushes nothing', () => {
    /* Given */
    const h = harness();
    const cwd = '/home/joris/projects/switchboard';
    const folder = encodeProjectPath(cwd);
    writeTranscript(h, folder, [user('hi', '2026-11-01T10:00:00.000Z', cwd)]);
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});

    /* When */
    writeTranscript(h, folder, [user('other', '2026-11-01T10:00:00.000Z', cwd)], 'other-session');
    h.watcher.fire(path.join(h.projects, folder));
    h.timers.tick();

    /* Then */
    assert.deepEqual(changes(h.received), []);
});

test('a launched session whose file appears later is pushed once it does', () => {
    /* Given */
    const h = harness();
    const cwd = '/home/joris/projects/switchboard';
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});
    assert.equal(reply(h.received, 'transcript', 'r1').transcript, null);

    /* When */
    writeTranscript(h, encodeProjectPath(cwd), [user('hi', '2026-11-01T10:00:00.000Z', cwd)]);
    h.timers.tick(); // the poll finds it
    h.timers.tick(); // the debounce fires

    /* Then */
    assert.deepEqual(changes(h.received), [[SESSION]]);
    assert.ok(h.watcher.open.has(path.join(h.projects, encodeProjectPath(cwd))));
});

test('a client going away stops the watching, unless another client asked too', () => {
    /* Given */
    const h = harness();
    const cwd = '/home/joris/projects/switchboard';
    const dir = path.join(h.projects, encodeProjectPath(cwd));
    const file = writeTranscript(h, encodeProjectPath(cwd), [user('hi', '2026-11-01T10:00:00.000Z', cwd)]);
    const other = h.second();
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});
    other.pair.mac.send({type: 'get-transcript', requestId: 'r2', sessionId: SESSION});

    /* When */
    h.pair.drop();
    const stillWatched = h.part.watchedIds;
    fs.appendFileSync(file, assistant('more', '2026-11-01T10:00:01.000Z', cwd) + '\n');
    h.watcher.fire(dir);
    h.timers.tick();
    other.pair.drop();

    /* Then */
    assert.deepEqual(stillWatched, [SESSION]);
    assert.deepEqual(changes(other.received), [[SESSION]]);
    assert.deepEqual(h.part.watchedIds, []);
    assert.equal(h.watcher.open.size, 0);
    assert.equal(h.timers.pending, 0);
});

test('the real folder watcher hears an append', async () => {
    /* Given */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-watch-'));
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, '{}\n');
    let heard = 0;
    const watch = new NodeFolderWatcher().watch(
        dir,
        () => heard++,
        () => {},
    );

    /* When */
    // A watch that has only just started can miss the very first write (macOS
    // starts FSEvents asynchronously), so keep appending until one is heard.
    const deadline = Date.now() + 10_000;
    while (heard === 0 && Date.now() < deadline) {
        fs.appendFileSync(file, '{}\n');
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    watch?.close();

    /* Then */
    assert.ok(watch);
    assert.ok(heard > 0);
});

// ── transcript-tail ──

test('the tail drops the partial first line', () => {
    /* Given */
    const h = harness();
    writeTranscript(h, '-p', ['{"n":1}', '{"n":2}', '{"n":3}']);

    /* When */
    // The file is `{"n":1}\n{"n":2}\n{"n":3}\n`: 12 bytes is `n":2}\n{"n":3}\n`.
    h.send({type: 'transcript-tail', requestId: 'r1', sessionId: SESSION, bytes: 12});
    // 16 bytes starts exactly on the second line.
    h.send({type: 'transcript-tail', requestId: 'r2', sessionId: SESSION, bytes: 16});
    h.send({type: 'transcript-tail', requestId: 'r3', sessionId: SESSION, bytes: TAIL_MAX_BYTES * 10});

    /* Then */
    assert.deepEqual(reply(h.received, 'transcript-tail', 'r1').lines, ['{"n":3}']);
    assert.deepEqual(reply(h.received, 'transcript-tail', 'r2').lines, ['{"n":2}', '{"n":3}']);
    assert.deepEqual(reply(h.received, 'transcript-tail', 'r3').lines, ['{"n":1}', '{"n":2}', '{"n":3}']);
});

test('the tail of a session with no file is empty', () => {
    /* Given */
    const h = harness();

    /* When */
    h.send({type: 'transcript-tail', requestId: 'r1', sessionId: SESSION, bytes: 1000});

    /* Then */
    assert.deepEqual(reply(h.received, 'transcript-tail', 'r1').lines, []);
});

// ── read-transcript ──

test('a transcript is read whole, slice by slice, raw', () => {
    /* Given */
    const h = harness();
    writeTranscript(h, '-p', ['{"n":1}', '{"n":2}']);

    /* When */
    // The file is `{"n":1}\n{"n":2}\n`: 16 bytes, read as 10 and the 6 after.
    h.send({type: 'read-transcript', requestId: 'r1', sessionId: SESSION, offset: 0, maxBytes: 10});
    h.send({type: 'read-transcript', requestId: 'r2', sessionId: SESSION, offset: 10, maxBytes: 10});
    h.send({type: 'read-transcript', requestId: 'r3', sessionId: SESSION, offset: 99, maxBytes: 10});

    /* Then */
    const slice = (id: string) => {
        const answer = reply(h.received, 'transcript-bytes', id);
        return {
            found: answer.found,
            size: answer.size,
            text: Buffer.from(answer.contentBase64 ?? '', 'base64').toString(),
        };
    };
    assert.deepEqual(slice('r1'), {found: true, size: 16, text: '{"n":1}\n{"'});
    assert.deepEqual(slice('r2'), {found: true, size: 16, text: 'n":2}\n'});
    assert.deepEqual(slice('r3'), {found: true, size: 16, text: ''});
});

test('reading a transcript the VM does not have, or a crafted id, finds nothing', () => {
    /* Given */
    const h = harness();
    writeTranscript(h, '-p', ['{"n":1}']);

    /* When */
    h.send({type: 'read-transcript', requestId: 'r1', sessionId: 'not-there', offset: 0, maxBytes: 10});
    h.send({type: 'read-transcript', requestId: 'r2', sessionId: '../-p/' + SESSION, offset: 0, maxBytes: 10});

    /* Then */
    assert.equal(reply(h.received, 'transcript-bytes', 'r1').found, false);
    assert.equal(reply(h.received, 'transcript-bytes', 'r2').found, false);
});

// ── import-transcript ──

test('an import places the upload at the encoded path, 0600', async () => {
    /* Given */
    const h = harness();
    const body = Buffer.from(user('hi', '2026-11-01T10:00:00.000Z', '/x') + '\n');
    const uploadId = await upload(h, body);
    const dir = path.join(h.home, 'projects', 'switchboard');
    fs.mkdirSync(dir, {recursive: true});

    /* When */
    h.send({type: 'import-transcript', requestId: 'r1', sessionId: SESSION, dir: '~/projects/switchboard/', uploadId});

    /* Then */
    assert.deepEqual(reply(h.received, 'done', 'r1'), {type: 'done', requestId: 'r1', ok: true});
    const target = path.join(h.projects, encodeProjectPath(dir), `${SESSION}.jsonl`);
    assert.deepEqual(fs.readFileSync(target), body);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(h.uploads.count, 0);
});

test("an import turns a handed-off transcript's ~ cwd into this machine's home, and leaves the rest", async () => {
    /* Given */
    const h = harness();
    const body = Buffer.from(user('hi', '2026-11-01T10:00:00.000Z', '~/projects/site') + '\n');
    const uploadId = await upload(h, body);
    const dir = path.join(h.home, 'projects', 'site');
    fs.mkdirSync(dir, {recursive: true});

    /* When */
    h.send({type: 'import-transcript', requestId: 'r1', sessionId: SESSION, dir: '~/projects/site', uploadId});

    /* Then */
    const target = path.join(h.projects, encodeProjectPath(dir), `${SESSION}.jsonl`);
    const written = fs.readFileSync(target, 'utf8');
    assert.equal(written, body.toString('utf8').replace('"cwd":"~/projects/site"', `"cwd":"${dir}"`));
});

test('an import makes a ~ cwd absolute however the JSON is spaced', async () => {
    /* Given */
    const h = harness();
    const line = JSON.stringify(JSON.parse(user('hi', '2026-11-01T10:00:00.000Z', '~/projects/site')), null, 1).replace(
        /\n/g,
        ' ',
    );
    const uploadId = await upload(h, Buffer.from(line + '\n'));
    const dir = path.join(h.home, 'projects', 'site');
    fs.mkdirSync(dir, {recursive: true});

    /* When */
    h.send({type: 'import-transcript', requestId: 'r1', sessionId: SESSION, dir: '~/projects/site', uploadId});

    /* Then */
    const target = path.join(h.projects, encodeProjectPath(dir), `${SESSION}.jsonl`);
    assert.equal((JSON.parse(fs.readFileSync(target, 'utf8')) as {cwd: string}).cwd, dir);
});

test('an import is refused when the id is already on the host', async () => {
    /* Given */
    const h = harness();
    const existing = writeTranscript(h, '-elsewhere', ['{"keep":true}']);
    const uploadId = await upload(h, Buffer.from('{"new":true}\n'));

    /* When */
    h.send({type: 'import-transcript', requestId: 'r1', sessionId: SESSION, dir: '~/projects/x', uploadId});

    /* Then */
    const done = reply(h.received, 'done', 'r1');
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /already on this host/);
    assert.equal(fs.readFileSync(existing, 'utf8'), '{"keep":true}\n');
    assert.equal(fs.existsSync(path.join(h.projects, encodeProjectPath(path.join(h.home, 'projects/x')))), false);
});

test('an import of an unknown upload is refused', () => {
    /* Given */
    const h = harness();

    /* When */
    h.send({type: 'import-transcript', requestId: 'r1', sessionId: SESSION, dir: '~/x', uploadId: 'nope'});

    /* Then */
    const done = reply(h.received, 'done', 'r1');
    assert.equal(done.ok, false);
    assert.match(done.error ?? '', /unknown upload nope/);
    assert.deepEqual(fs.readdirSync(h.projects), []);
});

test('an import a client waits on is pushed to it', async () => {
    /* Given */
    const h = harness();
    h.send({type: 'get-transcript', requestId: 'r1', sessionId: SESSION});
    const uploadId = await upload(h, Buffer.from(user('hi', '2026-11-01T10:00:00.000Z', '/x') + '\n'));

    /* When */
    h.send({type: 'import-transcript', requestId: 'r2', sessionId: SESSION, dir: '/srv/x', uploadId});
    h.timers.tick();

    /* Then */
    assert.equal(reply(h.received, 'done', 'r2').ok, true);
    assert.deepEqual(changes(h.received), [[SESSION]]);
});

// ── list-transcripts (stage 5) ──

/** A session id that differs by `n`, for many sessions at once. */
function sessionIdOf(n: number): string {
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Write a session started in `cwd`, with its file's mtime at `mtimeMs`. */
function session(h: Harness, cwd: string, sessionId: string, mtimeMs: number): string {
    const file = writeTranscript(h, encodeProjectPath(cwd), [user('Hi', '2026-11-01T10:00:00.000Z', cwd)], sessionId);
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
}

test('the sessions in a folder and below it are listed newest first, in ~ form', () => {
    /* Given */
    const h = harness();
    const app = path.join(h.home, 'projects', 'app');
    session(h, app, sessionIdOf(1), 1_000_000);
    session(h, path.join(app, '.claude', 'worktrees', 'fix'), sessionIdOf(2), 3_000_000);
    session(h, path.join(app, 'packages', 'web'), sessionIdOf(3), 2_000_000);
    session(h, path.join(h.home, 'projects', 'app-two'), sessionIdOf(4), 4_000_000);
    session(h, path.join(h.home, 'projects', 'other'), sessionIdOf(5), 5_000_000);

    /* When */
    h.send({type: 'list-transcripts', requestId: 'l1', dirs: ['~/projects/app']});

    /* Then */
    assert.deepEqual(reply(h.received, 'transcript-list', 'l1').sessions, [
        {sessionId: sessionIdOf(2), dir: '~/projects/app/.claude/worktrees/fix', mtimeMs: 3_000_000},
        {sessionId: sessionIdOf(3), dir: '~/projects/app/packages/web', mtimeMs: 2_000_000},
        {sessionId: sessionIdOf(1), dir: '~/projects/app', mtimeMs: 1_000_000},
    ]);
});

test('a folder outside home is matched and answered as it is', () => {
    /* Given */
    const h = harness();
    const srv = path.join(path.dirname(h.home), 'srv', 'api');
    session(h, srv, sessionIdOf(1), 1_000_000);

    /* When */
    h.send({type: 'list-transcripts', requestId: 'l2', dirs: [srv]});

    /* Then */
    assert.deepEqual(reply(h.received, 'transcript-list', 'l2').sessions, [
        {sessionId: sessionIdOf(1), dir: srv, mtimeMs: 1_000_000},
    ]);
});

test('only sessions modified since the given time are listed', () => {
    /* Given */
    const h = harness();
    const app = path.join(h.home, 'projects', 'app');
    session(h, app, sessionIdOf(1), 1_000_000);
    session(h, app, sessionIdOf(2), 2_000_000);
    session(h, app, sessionIdOf(3), 3_000_000);

    /* When */
    h.send({type: 'list-transcripts', requestId: 'l3', dirs: ['~/projects/app'], since: 2_000_000});

    /* Then */
    assert.deepEqual(
        reply(h.received, 'transcript-list', 'l3').sessions.map((s) => s.sessionId),
        [sessionIdOf(3), sessionIdOf(2)],
    );
});

test('the list holds at most the newest LIST_MAX_SESSIONS sessions', () => {
    /* Given */
    const h = harness();
    const app = path.join(h.home, 'projects', 'app');
    const count = LIST_MAX_SESSIONS + 25;
    for (let n = 1; n <= count; n++) session(h, app, sessionIdOf(n), n * 1000);

    /* When */
    h.send({type: 'list-transcripts', requestId: 'l4', dirs: ['~/projects/app']});

    /* Then */
    const sessions = reply(h.received, 'transcript-list', 'l4').sessions;
    assert.equal(sessions.length, LIST_MAX_SESSIONS);
    assert.equal(sessions[0]?.sessionId, sessionIdOf(count));
    assert.equal(sessions.at(-1)?.sessionId, sessionIdOf(count - LIST_MAX_SESSIONS + 1));
});

test('a session whose cwd is past a large opening line is still listed', () => {
    /* Given */
    const h = harness();
    const app = path.join(h.home, 'projects', 'app');
    const snapshot = JSON.stringify({type: 'file-history-snapshot', blob: 'x'.repeat(CWD_HEAD_BYTES * 2)});
    const file = writeTranscript(
        h,
        encodeProjectPath(app),
        [snapshot, user('Hi', '2026-11-01T10:00:00.000Z', app)],
        sessionIdOf(1),
    );
    fs.utimesSync(file, 1000, 1000);

    /* When */
    h.send({type: 'list-transcripts', requestId: 'l5', dirs: ['~/projects/app']});

    /* Then */
    assert.deepEqual(reply(h.received, 'transcript-list', 'l5').sessions, [
        {sessionId: sessionIdOf(1), dir: '~/projects/app', mtimeMs: 1_000_000},
    ]);
});

test('a folder with no sessions answers an empty list', () => {
    /* Given */
    const h = harness();

    /* When */
    h.send({type: 'list-transcripts', requestId: 'l6', dirs: ['~/projects/none']});

    /* Then */
    assert.deepEqual(reply(h.received, 'transcript-list', 'l6').sessions, []);
});

// ── set-transcript-aside ──

test('a transcript brought back to the Mac is set aside, renamed, and a second time gets a new name', () => {
    /* Given */
    const h = harness();
    const file = writeTranscript(h, '-p', ['{"n":1}']);

    /* When */
    h.send({type: 'set-transcript-aside', requestId: 'r1', sessionId: SESSION});
    writeTranscript(h, '-p', ['{"n":2}']);
    h.send({type: 'set-transcript-aside', requestId: 'r2', sessionId: SESSION});
    h.send({type: 'read-transcript', requestId: 'r3', sessionId: SESSION, offset: 0, maxBytes: 10});

    /* Then */
    assert.equal(reply(h.received, 'done', 'r1').ok, true);
    assert.equal(reply(h.received, 'done', 'r2').ok, true);
    assert.equal(fs.readFileSync(file + '.brought-back', 'utf8'), '{"n":1}\n');
    assert.equal(fs.readFileSync(file + '.brought-back-2', 'utf8'), '{"n":2}\n');
    assert.equal(fs.existsSync(file), false);
    assert.equal(reply(h.received, 'transcript-bytes', 'r3').found, false, 'nor is it found any more');
});
