/**
 * The agent's listening end: a Unix socket, one ClientLink per connection (#276).
 *
 * The Mac never connects here directly. It runs `switchboard-agent connect`
 * over ssh, and that bridge connects to this socket on the VM, so every
 * connection is one Mac. Trust is the file's: the socket is mode 0600, so only
 * the VM user (who is whoever ssh let in) can connect.
 *
 * Each connection's bytes are cut into frames by `domain/agent/framing`. A
 * frame that cannot be decoded ends the link with `bye protocol-error`; a
 * message that decodes but is not a well-formed MacMessage is the router's to
 * turn away, so the link hands every decoded message on as it came.
 *
 * Backpressure: frames are never dropped or reordered, because a missing chunk
 * of terminal output corrupts the screen and a missing message hangs a
 * request. Writes therefore always go to the socket, and Node buffers what the
 * kernel will not take yet. That buffer is capped (`MAX_BUFFERED_BYTES`): a
 * client so far behind is a stalled ssh link, not a slow one, and holding
 * output for it without limit would only grow the agent. Past the cap the link
 * is dropped, and the Mac reconnects and `attach`es, which replays what it
 * missed from the session's own scrollback by sequence number. Reading is not
 * throttled: every inbound chunk is decoded and dispatched synchronously, and
 * what the Mac sends (keystrokes, small requests) is tiny next to the output.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

import type {ClientLink} from '../../application/ports/agent-link';
import type {Logger} from '../../application/ports/logger';
import {encodeMessageFrame, encodeOutputFrame, FrameDecoder} from '../../domain/agent/framing';
import {AGENT_CLOSE, type AgentMessage, type MacMessage, type TerminalOutput} from '../../domain/agent/protocol';

/** Output a client may fall behind by before its link is dropped (see the file comment). */
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/** How long a closed link waits for its last frames to flush before it is cut. */
const CLOSE_FLUSH_MS = 2000;

/** How long the stale-socket check waits for a live agent to answer. */
const PROBE_TIMEOUT_MS = 1000;

export interface UnixSocketServerOptions {
    /** The socket's path, already expanded (no `$HOME`). */
    socketPath: string;
    /** Called once per connection, with the link it became. */
    onClient(client: ClientLink): void;
    log: Logger;
    /** Overrides `MAX_BUFFERED_BYTES`, for tests. */
    maxBufferedBytes?: number;
}

export interface UnixSocketServer {
    readonly socketPath: string;
    /** Stop listening, cut every link still open, and remove the socket file. */
    close(): Promise<void>;
}

/** Another agent already answers on the socket; this one must not take it over. */
export class AgentAlreadyRunningError extends Error {
    constructor(socketPath: string) {
        super(`an agent is already listening on ${socketPath}`);
        this.name = 'AgentAlreadyRunningError';
    }
}

/**
 * Listen on `socketPath`, replacing a stale socket file a crashed agent left
 * behind. Rejects with `AgentAlreadyRunningError` when a live agent answers
 * there, and leaves its socket alone.
 */
export async function listenOnUnixSocket(options: UnixSocketServerOptions): Promise<UnixSocketServer> {
    const {socketPath, onClient, log} = options;
    const maxBuffered = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

    // The folder holds nothing another user should read either.
    fs.mkdirSync(path.dirname(socketPath), {recursive: true, mode: 0o700});
    await clearStaleSocket(socketPath, log);

    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        onClient(socketLink(socket, log, maxBuffered));
    });

    // The socket is created by listen() with the process's umask applied, and
    // chmod'ed only after, so a narrow umask closes the window in between
    // where another user could connect. umask is process-wide, but this runs
    // once at startup before anything else creates files.
    const previousUmask = process.umask(0o177);
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.off('error', reject);
                resolve();
            });
        });
    } finally {
        process.umask(previousUmask);
    }
    fs.chmodSync(socketPath, 0o600);
    server.on('error', (err) => log.error('agent: socket server error', err));
    log.info(`agent: listening on ${socketPath}`);

    return {
        socketPath,
        close: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => {
                    // net removes its own socket file on close; this covers a
                    // server that never got as far.
                    fs.rmSync(socketPath, {force: true});
                    resolve();
                });
            }),
    };
}

/**
 * Remove a socket file nothing answers on. A live agent's socket, or a path
 * that is not a socket at all, is left in place and refused.
 */
async function clearStaleSocket(socketPath: string, log: Logger): Promise<void> {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(socketPath);
    } catch {
        return; // nothing there
    }
    if (!stat.isSocket()) throw new Error(`${socketPath} exists and is not a socket; not replacing it`);
    if (await answers(socketPath)) throw new AgentAlreadyRunningError(socketPath);
    log.info(`agent: removing stale socket ${socketPath}`);
    fs.unlinkSync(socketPath);
}

/** Whether something accepts a connection on `socketPath`. */
function answers(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = net.createConnection(socketPath);
        const done = (live: boolean) => {
            probe.destroy();
            resolve(live);
        };
        probe.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
        probe.once('connect', () => done(true));
        probe.once('error', () => done(false));
    });
}

/** One connection as a ClientLink, framed both ways. */
function socketLink(socket: net.Socket, log: Logger, maxBuffered: number): ClientLink {
    const decoder = new FrameDecoder();
    const messageListeners: ((message: MacMessage) => void)[] = [];
    const closeListeners: ((reason: string) => void)[] = [];
    let closed = false;

    /** Mark the link gone and tell its listeners, once, whichever way it went. */
    const gone = (reason: string) => {
        if (closed) return;
        closed = true;
        for (const listener of closeListeners) listener(reason);
    };

    /** End our side after flushing what is queued (a `bye`), and cut it if the peer never lets go. */
    const close = (reason: string) => {
        if (socket.destroyed) return gone(reason);
        socket.end();
        setTimeout(() => socket.destroy(), CLOSE_FLUSH_MS).unref();
        gone(reason);
    };

    const write = (frame: Buffer) => {
        if (closed) return;
        socket.write(frame);
        if (socket.writableLength > maxBuffered) {
            log.warn(`agent: client ${socket.writableLength} bytes behind; dropping the link`);
            socket.destroy();
            gone('client too far behind');
        }
    };

    socket.on('data', (chunk: Buffer) => {
        if (closed) return;
        let frames;
        try {
            frames = decoder.push(chunk);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            write(encodeMessageFrame({type: 'bye', code: AGENT_CLOSE.protocolError, reason}));
            return close(`protocol error: ${reason}`);
        }
        for (const frame of frames) {
            if (closed) return;
            if (frame.kind === 'output') {
                write(
                    encodeMessageFrame({
                        type: 'bye',
                        code: AGENT_CLOSE.protocolError,
                        reason: 'output frames go agent → Mac only',
                    }),
                );
                return close('protocol error: output frame from client');
            }
            // Checked by the router (domain/agent/validate), which owns the
            // protocol's rules; the cast only names what it should be.
            for (const listener of messageListeners) listener(frame.message as MacMessage);
        }
    });
    socket.on('end', () => close('client ended the link'));
    socket.on('error', (err) => gone(`socket error: ${err.message}`));
    socket.on('close', () => gone('socket closed'));

    return {
        send: (message: AgentMessage) => write(encodeMessageFrame(message)),
        sendOutput: (output: TerminalOutput) => write(encodeOutputFrame(output)),
        onMessage: (listener) => void messageListeners.push(listener),
        onClose: (listener) => void closeListeners.push(listener),
        close: () => close('closed by agent'),
        get closed() {
            return closed;
        },
    };
}
