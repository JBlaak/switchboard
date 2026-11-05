/**
 * The Mac's side of every VM host (#276): one connection per host, the
 * stand-in PTYs of the sessions on it, and the hooks they forward.
 *
 * A VM session on the Mac is an ordinary ActiveSession whose PTY is an
 * AgentPty. This is what makes that true: it opens the session on the agent,
 * routes the host's output and `exited` to the right stand-in, sends what the
 * stand-ins are asked to do, and keeps every session's card in step with its
 * host's link. After a drop it picks every live session up again where it left
 * off (`attach` from the last sequence number shown), clearing the screen
 * first when the agent no longer has that point.
 *
 * Sessions are not stopped when the Mac goes away: `shutdown` closes the
 * links and nothing else, and the work goes on on the VM.
 */
import {parseRemoteProjectPath} from '../../../domain/project/remote-target';
import type {AgentSessionKind, SignalMessage} from '../../../domain/agent/protocol';
import type {SessionOptions} from '../../../domain/launch/session-options';
import type {RemoteConfig} from '../../../domain/project/remote-target';
import type {RemoteStatusPayload} from '../../../domain/remote/remote-status';
import type {SessionRegistry} from '../../model/session-registry';
import type {AgentDialer} from '../../ports/agent-link';
import type {Clock, Timers} from '../../ports/clock';
import type {Logger} from '../../ports/logger';
import type {RendererGateway} from '../../ports/renderer-gateway';
import {AgentConnection} from './agent-connection';
import {AgentPty} from './agent-pty';
import type {AgentPtySink} from './agent-pty';
import {HookRelay} from './hook-relay';
import type {HookRelayDeps} from './hook-relay';

/** RIS: a full terminal reset, written before a replay that does not continue from what is on screen. */
export const TERMINAL_RESET = '\x1bc';

/** Which connection a host gets: one per user, host and port. */
export function agentHostKey(host: Pick<RemoteConfig, 'user' | 'host' | 'port'>): string {
    return `${host.user}@${host.host}:${Number(host.port) || 22}`;
}

export interface AgentClientDeps extends HookRelayDeps {
    dialer: AgentDialer;
    /** The app's version, which every agent's must equal. */
    appVersion: string;
    /** To tell the cards of a re-keyed session apart, and to drop stand-ins nobody holds any more. */
    registry: Pick<SessionRegistry, 'find'>;
    renderer: Pick<RendererGateway, 'remoteStatus'>;
    timers: Timers;
    clock: Clock;
    log: Logger;
    requestTimeoutMs?: number;
    handshakeTimeoutMs?: number;
}

/** A session to open on a host's agent. */
export interface AgentSessionSpec {
    sessionId: string;
    host: RemoteConfig;
    kind: AgentSessionKind;
    /** The project's directory on the VM, as the project path names it; empty for home. */
    dir: string;
    isNew: boolean;
    options?: SessionOptions;
    /** For a shell: what the agent types into it once it is up (the setup terminal's script). */
    command?: string;
    cols: number;
    rows: number;
}

export type AgentOpenResult = {ok: true; reattached: boolean} | {ok: false; error: string};

export class AgentClient {
    private readonly connections = new Map<string, AgentConnection>();
    /** Every stand-in not yet exited, by the id it was opened under. */
    private readonly ptys = new Map<string, AgentPty>();
    private readonly connectedListeners: ((connection: AgentConnection) => void)[] = [];
    private readonly reinstallListeners: ((host: RemoteConfig, reason: string) => void)[] = [];
    private readonly disconnectedListeners: ((connection: AgentConnection) => void)[] = [];
    private shutDown = false;

    constructor(private readonly deps: AgentClientDeps) {}

    /** The host's connection, made (not dialled) on first use. */
    public connection(host: RemoteConfig): AgentConnection {
        const key = agentHostKey(host);
        let connection = this.connections.get(key);
        if (connection) return connection;

        const {dialer, appVersion, timers, clock, log, requestTimeoutMs, handshakeTimeoutMs} = this.deps;
        connection = new AgentConnection({
            host: {user: host.user, host: host.host, port: Number(host.port) || 22},
            dialer,
            appVersion,
            timers,
            clock,
            log,
            requestTimeoutMs,
            handshakeTimeoutMs,
        });
        this.connections.set(key, connection);
        this.wire(key, connection);
        return connection;
    }

    /** The connection of the host a project path (`ssh://…`) is on, or null for a local path. */
    public connectionFor(projectPath: string): AgentConnection | null {
        const parsed = parseRemoteProjectPath(projectPath);
        return parsed ? this.connection(parsed) : null;
    }

    /** After every (re)connect of any host, once its sessions have reattached; the config copy hangs off this. */
    public onConnected(listener: (connection: AgentConnection) => void): void {
        this.connectedListeners.push(listener);
    }

    /** A host's agent is another version than the app, or missing. */
    public onNeedsReinstall(listener: (host: RemoteConfig, reason: string) => void): void {
        this.reinstallListeners.push(listener);
    }

    /**
     * Open a session on its host's agent.
     *
     * The stand-in comes back at once, so the caller can register and wire the
     * session (and its card can show the connection coming up) while the link
     * is dialled and the agent answers; `opened` settles with that answer. On a
     * refusal the stand-in is forgotten and must not be used.
     */
    public startSession(spec: AgentSessionSpec): {pty: AgentPty; opened: Promise<AgentOpenResult>} {
        const connection = this.connection(spec.host);
        const pty = new AgentPty({
            sessionId: spec.sessionId,
            hostKey: agentHostKey(spec.host),
            kind: spec.kind,
            cols: spec.cols,
            rows: spec.rows,
            sink: this.sinkFor(connection),
        });
        this.track(pty);

        // Opening a session is asking for its host, so a link that gave up tries again.
        if (connection.state === 'failed') connection.retryNow();
        const opened = connection
            .open({
                sessionId: spec.sessionId,
                kind: spec.kind,
                dir: spec.dir,
                isNew: spec.isNew,
                ...(spec.options ? {options: spec.options} : {}),
                ...(spec.command ? {command: spec.command} : {}),
                cols: spec.cols,
                rows: spec.rows,
            })
            .then(
                (reply): AgentOpenResult => {
                    if (!reply.ok) {
                        this.forget(pty);
                        return {ok: false, error: reply.error || 'the agent could not open the session'};
                    }
                    pty.opened = true;
                    // Whatever happened while the open was on its way: a stop, or the
                    // renderer reporting its real size.
                    this.flushSignal(connection, pty);
                    if (pty.cols !== spec.cols || pty.rows !== spec.rows) {
                        connection.send({type: 'resize', sessionId: pty.sessionId, cols: pty.cols, rows: pty.rows});
                    }
                    return {ok: true, reattached: !!reply.reattached};
                },
                (err: Error): AgentOpenResult => {
                    this.forget(pty);
                    return {ok: false, error: `could not reach the agent on ${connection.target}: ${err.message}`};
                },
            );
        return {pty, opened};
    }

    /**
     * A session came on screen (opened, or a renderer reattached): tell its card
     * where the host's link stands, and when the link had given up, try again,
     * because looking at the session is asking for it back.
     */
    public sessionShown(sessionId: string, pty: AgentPty): void {
        const connection = this.connectionByKey(pty.hostKey);
        if (!connection) return;
        if (connection.status) this.deps.renderer.remoteStatus(sessionId, connection.status);
        if (connection.state === 'failed') connection.retryNow();
    }

    /**
     * "Retry now" on a VM session's card: its host's link dials at once,
     * skipping the rest of a backoff, or starting over after it gave up. The
     * session needs nothing of its own: it reattaches when the link is back.
     */
    public retryHostOf(pty: AgentPty): {ok: boolean; alreadyConnected?: boolean; error?: string} {
        const connection = this.connectionByKey(pty.hostKey);
        if (!connection) return {ok: false, error: 'no link to its host'};
        if (connection.state === 'connected') return {ok: true, alreadyConnected: true};
        connection.retryNow();
        return {ok: true};
    }

    /**
     * Let go of a session the Mac no longer holds (its project was forgotten
     * here), leaving it running on its VM: its output stops reaching the
     * stand-in, and the next reconnect does not reattach it. Opening it again
     * later (the project added back) reattaches as any open of a live id does.
     */
    public release(pty: AgentPty): void {
        this.forget(pty);
    }

    /**
     * Close the host's link for good and forget it, without telling the agent
     * anything: for a VM taken out of Settings → VMs. Its agent and sessions
     * keep running there, and the Mac lets go of every stand-in it held on the
     * host. A later `connection` for the host makes a fresh link, so
     * registering the VM again picks its sessions back up.
     */
    public disconnect(host: Pick<RemoteConfig, 'user' | 'host' | 'port'>): void {
        const key = agentHostKey(host);
        for (const pty of [...this.ptys.values()]) if (pty.hostKey === key) this.forget(pty);
        const connection = this.connections.get(key);
        if (!connection) return;
        this.connections.delete(key);
        connection.close();
    }

    /** A host's link dropped or was closed; the Settings → VMs list follows its "connected". */
    public onDisconnected(listener: (connection: AgentConnection) => void): void {
        this.disconnectedListeners.push(listener);
    }

    /**
     * Close every link, leaving every session running on its VM. For the app
     * quitting: call it before the lifecycle signals its sessions, so the
     * signals meant for local processes never reach a VM.
     */
    public shutdown(): void {
        this.shutDown = true;
        for (const connection of this.connections.values()) connection.close();
    }

    // ── Wiring ──

    private wire(key: string, connection: AgentConnection): void {
        new HookRelay(connection, {questions: this.deps.questions, archiveTool: this.deps.archiveTool});

        connection.onStatus((status) => this.fanOut(key, status));

        connection.onOutput((output) => {
            const pty = this.ptys.get(output.sessionId);
            if (pty && pty.hostKey === key) pty.feed(output.seq, output.data);
        });

        connection.onMessage((message) => {
            switch (message.type) {
                case 'exited': {
                    const pty = this.ptyOn(key, message.sessionId);
                    if (!pty) return;
                    this.forget(pty);
                    pty.exit(message.exitCode, message.signal);
                    break;
                }
                case 'attached': {
                    const pty = this.ptyOn(key, message.sessionId);
                    if (!pty) return;
                    if (!message.alive) {
                        // It ended while the Mac was away.
                        this.forget(pty);
                        pty.exit(0);
                        return;
                    }
                    if (message.reset) pty.inject(TERMINAL_RESET);
                    break;
                }
            }
        });

        connection.onNeedsReinstall((reason) => this.reinstallListeners.forEach((l) => l(connection.host, reason)));

        connection.onConnected(() => {
            this.reattachAll(key, connection);
            this.connectedListeners.forEach((l) => l(connection));
        });

        connection.onDisconnected(() => this.disconnectedListeners.forEach((l) => l(connection)));
    }

    /**
     * After a relink, pick up every live session on the host from what it last
     * showed. A stop asked for while the link was down goes first; a session the
     * Mac no longer holds (retired while away) is only told, not reattached.
     */
    private reattachAll(key: string, connection: AgentConnection): void {
        for (const pty of [...this.ptys.values()]) {
            if (pty.hostKey !== key || !pty.opened || pty.disposed) continue;
            this.flushSignal(connection, pty);
            if (!this.deps.registry.find(pty.sessionId)) {
                this.forget(pty);
                continue;
            }
            connection.attach(pty.sessionId, pty.lastSeq, pty.cols, pty.rows);
        }
    }

    private sinkFor(connection: AgentConnection): AgentPtySink {
        return {
            input: (sessionId, data) => {
                if (!this.shutDown) connection.send({type: 'input', sessionId, data});
            },
            resize: (sessionId, cols, rows) => {
                if (!this.shutDown) connection.send({type: 'resize', sessionId, cols, rows});
            },
            signal: (sessionId, signal) => {
                if (this.shutDown) return;
                const pty = this.ptys.get(sessionId);
                const ready = pty?.opened ?? true;
                if (ready && connection.send({type: 'signal', sessionId, signal})) {
                    if (pty) pty.pendingSignal = null;
                    return;
                }
                // Down, or the open is still on its way: kept until it can go.
                if (pty) pty.pendingSignal = strongest(pty.pendingSignal, signal);
            },
        };
    }

    private flushSignal(connection: AgentConnection, pty: AgentPty): void {
        const signal = pty.pendingSignal;
        if (!signal) return;
        if (connection.send({type: 'signal', sessionId: pty.sessionId, signal})) pty.pendingSignal = null;
    }

    /** Send a host's status to the card of every session on it, under the id its row has now. */
    private fanOut(key: string, status: RemoteStatusPayload): void {
        for (const pty of this.ptys.values()) {
            if (pty.hostKey !== key) continue;
            const found = this.deps.registry.find(pty.sessionId);
            // Retired while the agent had not yet said it exited: nobody shows it any more.
            if (!found && pty.opened) continue;
            const id = found ? found.session.realSessionId || found.key : pty.sessionId;
            this.deps.renderer.remoteStatus(id, status);
        }
    }

    private track(pty: AgentPty): void {
        const previous = this.ptys.get(pty.sessionId);
        if (previous && previous !== pty) this.deps.log.warn(`[agent] session=${pty.sessionId} opened twice`);
        this.ptys.set(pty.sessionId, pty);
    }

    private forget(pty: AgentPty): void {
        if (this.ptys.get(pty.sessionId) === pty) this.ptys.delete(pty.sessionId);
    }

    private ptyOn(key: string, sessionId: string): AgentPty | null {
        const pty = this.ptys.get(sessionId);
        return pty && pty.hostKey === key ? pty : null;
    }

    private connectionByKey(key: string): AgentConnection | null {
        return this.connections.get(key) ?? null;
    }
}

/** Of two pending signals, the one that ends more: a later SIGKILL must not be lost to an earlier SIGTERM. */
function strongest(a: SignalMessage['signal'] | null, b: SignalMessage['signal']): SignalMessage['signal'] {
    const rank = {SIGINT: 0, SIGHUP: 1, SIGTERM: 2, SIGKILL: 3} as const;
    return a && rank[a] > rank[b] ? a : b;
}
