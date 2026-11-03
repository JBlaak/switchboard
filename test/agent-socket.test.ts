import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
    AgentAlreadyRunningError,
    listenOnUnixSocket,
    type UnixSocketServer,
} from '../src/infrastructure/agent/unix-socket-server';
import {startAgent} from '../src/agent/main';
import {encodeMessageFrame, encodeOutputFrame, FrameDecoder, type Frame} from '../src/domain/agent/framing';
import type {ClientLink} from '../src/application/ports/agent-link';
import type {Logger} from '../src/application/ports/logger';
import type {AgentParts} from '../src/application/services/agent-host/agent-host';
import {AGENT_PROTOCOL_VERSION, type MacMessage} from '../src/domain/agent/protocol';

/**
 * The agent's Unix socket: real servers on sockets in a temp folder, and real
 * clients talking frames to them.
 */

const quietLog: Logger = {debug() {}, info() {}, warn() {}, error() {}};
const HELLO: MacMessage = {type: 'hello', protocol: AGENT_PROTOCOL_VERSION, appVersion: '2.12.0'};
const CONNECT_JS = path.resolve(__dirname, '../app/agent/connect.js');

// Short: a Unix socket path is limited to ~104 bytes on macOS.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agent-'));
after(() => fs.rmSync(dir, {recursive: true, force: true}));
let counter = 0;
const socketPath = () => path.join(dir, `a${counter++}.sock`);

/** A server whose links are handed out as they come. */
async function serve(at = socketPath(), maxBufferedBytes?: number) {
    const links: ClientLink[] = [];
    const waiting: ((link: ClientLink) => void)[] = [];
    const server = await listenOnUnixSocket({
        socketPath: at,
        log: quietLog,
        maxBufferedBytes,
        onClient: (link) => {
            const next = waiting.shift();
            if (next) next(link);
            else links.push(link);
        },
    });
    const nextLink = () =>
        new Promise<ClientLink>((resolve) => {
            const ready = links.shift();
            if (ready) resolve(ready);
            else waiting.push(resolve);
        });
    return {server, nextLink, at};
}

/** A raw client that collects decoded frames. */
async function client(at: string) {
    const socket = net.createConnection(at);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    const decoder = new FrameDecoder();
    const frames: Frame[] = [];
    const listeners: (() => void)[] = [];
    socket.on('data', (chunk: Buffer) => {
        frames.push(...decoder.push(chunk));
        listeners.forEach((l) => l());
    });
    const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const frameCount = (n: number) =>
        new Promise<void>((resolve) => {
            const check = () => frames.length >= n && resolve();
            listeners.push(check);
            check();
        });
    return {socket, frames, frameCount, ended};
}

const nextMessage = (link: ClientLink) => new Promise<MacMessage>((resolve) => link.onMessage(resolve));
const closedWith = (link: ClientLink) => new Promise<string>((resolve) => link.onClose(resolve));

/** Leaves a socket file nothing listens on, as an agent killed with SIGKILL does. */
function staleSocketAt(at: string): void {
    const script = `require('net').createServer().listen(${JSON.stringify(at)}, () => process.kill(process.pid, 'SIGKILL'))`;
    spawnSync(process.execPath, ['-e', script]);
}

const close = (server: UnixSocketServer) => server.close();

test('a message reaches the agent, and a message and output reach the client', async () => {
    /* Given */
    const {server, nextLink, at} = await serve();
    const mac = await client(at);
    const link = await nextLink();
    const received = nextMessage(link);

    /* When */
    mac.socket.write(encodeMessageFrame(HELLO));
    link.send({type: 'done', requestId: 'r', ok: true});
    link.sendOutput({sessionId: 's1', seq: 7, data: 'héllo'});

    /* Then */
    assert.deepEqual(await received, HELLO);
    await mac.frameCount(2);
    assert.deepEqual(mac.frames, [
        {kind: 'message', message: {type: 'done', requestId: 'r', ok: true}},
        {kind: 'output', output: {sessionId: 's1', seq: 7, data: 'héllo'}},
    ]);
    mac.socket.destroy();
    await close(server);
});

test('the socket is readable by its owner only', async () => {
    /* Given */
    const {server, at} = await serve();

    /* When */
    const mode = fs.statSync(at).mode & 0o777;

    /* Then */
    assert.equal(mode, 0o600);
    await close(server);
});

test('a stale socket file is replaced', async () => {
    /* Given */
    const at = socketPath();
    staleSocketAt(at);

    /* When */
    const {server} = await serve(at);
    const mac = await client(at);

    /* Then */
    assert.equal(mac.socket.readyState, 'open');
    mac.socket.destroy();
    await close(server);
});

test('a live agent on the socket is not replaced', async () => {
    /* Given */
    const {server, at} = await serve();

    /* When */
    const second = serve(at);

    /* Then */
    await assert.rejects(second, AgentAlreadyRunningError);
    assert.ok(fs.lstatSync(at).isSocket());
    await close(server);
});

test('a frame that cannot be decoded ends the link with bye protocol-error', async () => {
    /* Given */
    const {server, nextLink, at} = await serve();
    const mac = await client(at);
    const link = await nextLink();
    const closed = closedWith(link);

    /* When */
    const unknownKind = Buffer.from([0, 0, 0, 2, 9, 9]);
    mac.socket.write(unknownKind);

    /* Then */
    assert.match(await closed, /protocol error/);
    await mac.ended;
    assert.equal(mac.frames.length, 1);
    const bye = mac.frames[0].kind === 'message' ? (mac.frames[0].message as {type: string; code: string}) : null;
    assert.equal(bye?.type, 'bye');
    assert.equal(bye?.code, 'protocol-error');
    await close(server);
});

test('output sent by the client ends the link: output only flows agent to Mac', async () => {
    /* Given */
    const {server, nextLink, at} = await serve();
    const mac = await client(at);
    const link = await nextLink();
    const closed = closedWith(link);

    /* When */
    mac.socket.write(encodeOutputFrame({sessionId: 's', seq: 0, data: 'x'}));

    /* Then */
    assert.match(await closed, /output frame/);
    await close(server);
});

test('a client too far behind is dropped rather than buffered without end', async () => {
    /* Given */
    const {server, nextLink, at} = await serve(socketPath(), 64 * 1024);
    const mac = await client(at);
    mac.socket.pause(); // a stalled reader
    const link = await nextLink();
    const closed = closedWith(link);

    /* When */
    const chunk = 'x'.repeat(16 * 1024);
    for (let seq = 0; seq < 1000 && !link.closed; seq++) link.sendOutput({sessionId: 's', seq, data: chunk});

    /* Then */
    assert.equal(await closed, 'client too far behind');
    mac.socket.destroy();
    await close(server);
});

test('the client ending its side closes the link', async () => {
    /* Given */
    const {server, nextLink, at} = await serve();
    const mac = await client(at);
    const link = await nextLink();
    const closed = closedWith(link);

    /* When */
    mac.socket.end();

    /* Then */
    assert.equal(await closed, 'client ended the link');
    assert.equal(link.closed, true);
    await close(server);
});

/** Fake parts that only answer what the handshake needs. */
function idleParts(): AgentParts {
    const aware = {clientConnected() {}, clientGone() {}};
    return {
        sessions: {...aware, handle() {}, terminateAll() {}},
        copies: {...aware, handle() {}},
        transcripts: {...aware, handle() {}},
        tools: {...aware, handle() {}},
        hooks: {...aware, handle() {}, settingsFor: () => null, toolsFor: () => null},
        config: {
            ...aware,
            handle() {},
            current: () => ({instructions: '', copyConfig: true, baseFolder: '~/projects'}),
        },
    };
}

test('the started agent welcomes a client over its socket, and stopping says bye', async () => {
    /* Given */
    const at = socketPath();
    const agent = await startAgent({parts: idleParts(), socketPath: at, agentVersion: '2.12.0', log: quietLog});
    const mac = await client(at);
    mac.socket.write(encodeMessageFrame(HELLO));
    await mac.frameCount(1);

    /* When */
    await agent.stop();

    /* Then */
    await mac.ended;
    const types = mac.frames.map((f) => (f.kind === 'message' ? (f.message as {type: string; code?: string}) : null));
    assert.equal(types[0]?.type, 'welcome');
    assert.equal(types[1]?.code, 'shutting-down');
    assert.equal(fs.existsSync(at), false);
});

test('the built connect bridge carries frames both ways and exits 0 when stdin ends', async (t) => {
    if (!fs.existsSync(CONNECT_JS)) return t.skip('app/agent/connect.js is not built (npm run build)');
    /* Given */
    const {server, nextLink, at} = await serve();
    const child = spawn(process.execPath, [CONNECT_JS, 'connect'], {
        env: {...process.env, SWITCHBOARD_AGENT_SOCKET: at},
        stdio: ['pipe', 'pipe', 'inherit'],
    });
    const decoder = new FrameDecoder();
    const fromAgent: Frame[] = [];
    child.stdout.on('data', (chunk: Buffer) => fromAgent.push(...decoder.push(chunk)));
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const link = await nextLink();
    const received = nextMessage(link);

    /* When */
    child.stdin.write(encodeMessageFrame(HELLO));
    const hello = await received;
    link.sendOutput({sessionId: 's1', seq: 0, data: 'from the VM'});
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.stdin.end();

    /* Then */
    assert.deepEqual(hello, HELLO);
    assert.equal(await exited, 0);
    assert.deepEqual(fromAgent, [{kind: 'output', output: {sessionId: 's1', seq: 0, data: 'from the VM'}}]);
    await close(server);
});

test('the built connect bridge exits 1 with a message when no agent listens', async (t) => {
    if (!fs.existsSync(CONNECT_JS)) return t.skip('app/agent/connect.js is not built (npm run build)');
    /* Given */
    const missing = path.join(dir, 'missing.sock');

    /* When */
    const result = spawnSync(process.execPath, [CONNECT_JS, 'connect'], {
        env: {...process.env, SWITCHBOARD_AGENT_SOCKET: missing},
        encoding: 'utf8',
    });

    /* Then */
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot reach the agent/);
});
