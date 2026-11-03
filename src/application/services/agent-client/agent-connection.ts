/**
 * The Mac's one link to one host's agent (#276), kept up.
 *
 * Every session on a VM shares this link, so its health is the host's, not a
 * session's: when it drops, every session there is "reconnecting" at once and
 * is told so through the same RemoteStatusPayload the legacy ssh+tmux card
 * already renders. The sessions themselves keep running on the VM; a drop is a
 * transport problem to retry, with the legacy reconnect policy's backoff and
 * bounds.
 *
 * What it does:
 * - dials, sends `hello` and waits for `welcome`, keeping the host settings;
 * - on a version mismatch (the agent's `bye`, or a `welcome` at another
 *   protocol) stops and asks for a reinstall instead of redialling in a loop,
 *   because every redial would be refused the same way;
 * - on a drop, redials on the `remoteRetryDelay` ladder, and gives up after
 *   `MAX_RETRIES` until someone asks again (`retryNow`, or a new request);
 * - correlates requests and their answers by `requestId`, with a timeout, so a
 *   wedged agent fails a call instead of hanging it.
 *
 * Messages the agent sends unasked (output, `exited`, `attached`, hook
 * forwards) go to whoever listens: the session side and the hook relay.
 */
import {AGENT_CLOSE, AGENT_PROTOCOL_VERSION} from '../../../domain/agent/protocol';
import {
    isFatalSshOutput,
    MAX_RETRIES,
    REMOTE_STABLE_MS,
    remoteRetryDelay,
} from '../../../domain/remote/reconnect-policy';
import type {
    AgentMessage,
    AgentSessionInfo,
    ConfigFile,
    DoneMessage,
    HostSettings,
    MacMessage,
    OpenedMessage,
    OpenSessionMessage,
    TerminalOutput,
    ToolCheck,
    WelcomeMessage,
} from '../../../domain/agent/protocol';
import type {RemoteConfig} from '../../../domain/project/remote-target';
import type {RemoteStatusPayload} from '../../../domain/remote/remote-status';
import type {AgentDialer, AgentLink} from '../../ports/agent-link';
import type {Clock, TimerHandle, Timers} from '../../ports/clock';
import type {Logger} from '../../ports/logger';

/** How long a request may wait for its answer once sent. */
export const AGENT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long the handshake may take once ssh is running. Generous: it includes
 * ssh's own authentication, which may be waiting on a 1Password approval.
 */
export const AGENT_HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * What a connect command that is not there says, in bash's, dash's and zsh's
 * words: the host has no agent (any more), so redialling cannot help and a
 * (re)install can.
 */
const AGENT_MISSING = /switchboard-agent[^\n]*(?:No such file|not found)/i;

export type AgentConnectionPhase =
    /** Never dialled, or reset; dials on the first request. */
    | 'idle'
    | 'dialing'
    /** ssh is up and `hello` sent; waiting for `welcome`. */
    | 'handshaking'
    | 'connected'
    /** Between attempts, on the backoff timer. */
    | 'waiting'
    /** Gave up (out of attempts, or the host rejected us); dials again only when asked. */
    | 'failed'
    /** The agent is another version or missing; dials again only when asked, after a reinstall. */
    | 'needs-reinstall'
    /** Closed for good (the app is quitting). */
    | 'closed';

export interface AgentConnectionDeps {
    host: RemoteConfig;
    dialer: AgentDialer;
    /** The app's version, which the agent's must equal. */
    appVersion: string;
    timers: Timers;
    clock: Clock;
    log: Logger;
    requestTimeoutMs?: number;
    handshakeTimeoutMs?: number;
}

/** An `open` as the session side asks for it; the request id is the connection's business. */
export type OpenSpec = Omit<OpenSessionMessage, 'type' | 'requestId'>;

/** Messages the agent sends unasked, which the connection hands on. */
export type UnaskedMessage = Exclude<AgentMessage, {requestId: string} | WelcomeMessage | {type: 'bye'}>;

interface Pending {
    resolve(message: AgentMessage): void;
    reject(error: Error): void;
    timer: TimerHandle;
}

interface Waiter {
    resolve(): void;
    reject(error: Error): void;
}

export class AgentConnection {
    /** `user@host`: what the card says it is connecting to. */
    public readonly target: string;

    private phase: AgentConnectionPhase = 'idle';
    private link: AgentLink | null = null;
    private hostSettings: HostSettings | null = null;
    private attempt = 0;
    private everConnected = false;
    private connectedAt = 0;
    private retryTimer: TimerHandle | null = null;
    private handshakeTimer: TimerHandle | null = null;
    /** Why the link is in its current trouble, for the waiters it fails. */
    private lastReason = '';
    private lastStatus: RemoteStatusPayload | null = null;
    private nextRequest = 0;

    private readonly pending = new Map<string, Pending>();
    private waiters: Waiter[] = [];

    private readonly statusListeners: ((status: RemoteStatusPayload) => void)[] = [];
    private readonly connectedListeners: ((connection: AgentConnection) => void)[] = [];
    private readonly disconnectedListeners: ((reason: string) => void)[] = [];
    private readonly reinstallListeners: ((reason: string) => void)[] = [];
    private readonly messageListeners: ((message: UnaskedMessage) => void)[] = [];
    private readonly outputListeners: ((output: TerminalOutput) => void)[] = [];

    constructor(private readonly deps: AgentConnectionDeps) {
        this.target = `${deps.host.user}@${deps.host.host}`;
    }

    // ── State ──

    public get host(): RemoteConfig {
        return this.deps.host;
    }

    public get state(): AgentConnectionPhase {
        return this.phase;
    }

    public get connected(): boolean {
        return this.phase === 'connected';
    }

    /** The host settings the last `welcome` (or settings reply) carried; null before the first. */
    public get settings(): HostSettings | null {
        return this.hostSettings;
    }

    /** The last status sent, for a session that has just come on screen. */
    public get status(): RemoteStatusPayload | null {
        return this.lastStatus;
    }

    // ── Listeners ──

    /** Every status change, for the cards of every session on this host. */
    public onStatus(listener: (status: RemoteStatusPayload) => void): void {
        this.statusListeners.push(listener);
    }

    /** After every handshake, first or after a drop; what runs on each (re)connect, like the config copy. */
    public onConnected(listener: (connection: AgentConnection) => void): void {
        this.connectedListeners.push(listener);
    }

    /** The link went away after a handshake; whatever it held is gone with it. */
    public onDisconnected(listener: (reason: string) => void): void {
        this.disconnectedListeners.push(listener);
    }

    /** The agent is another version than the app, or missing: reinstall, then `retryNow`. */
    public onNeedsReinstall(listener: (reason: string) => void): void {
        this.reinstallListeners.push(listener);
    }

    public onMessage(listener: (message: UnaskedMessage) => void): void {
        this.messageListeners.push(listener);
    }

    public onOutput(listener: (output: TerminalOutput) => void): void {
        this.outputListeners.push(listener);
    }

    // ── Connecting ──

    /**
     * Resolves once the link is up, dialling if nothing is under way.
     *
     * A connection that gave up (out of attempts, or needing a reinstall) is not
     * redialled here: a request made then fails at once with the reason, and it
     * is `retryNow` that starts over.
     */
    public whenConnected(): Promise<void> {
        if (this.phase === 'connected') return Promise.resolve();
        if (this.phase === 'closed') return Promise.reject(new Error('the agent connection is closed'));
        if (this.phase === 'needs-reinstall' || this.phase === 'failed') {
            return Promise.reject(new Error(this.lastReason || 'the agent is not reachable'));
        }
        const waiting = new Promise<void>((resolve, reject) => this.waiters.push({resolve, reject}));
        if (this.phase === 'idle') {
            this.attempt = 0;
            void this.dial();
        }
        return waiting;
    }

    /**
     * Dial now: skips a pending backoff, and starts over after giving up or after
     * a reinstall. A no-op while connected or already dialling.
     */
    public retryNow(): void {
        if (this.phase === 'closed' || this.phase === 'connected') return;
        if (this.phase === 'dialing' || this.phase === 'handshaking') return;
        this.deps.timers.clearTimeout(this.retryTimer);
        this.retryTimer = null;
        if (this.phase !== 'waiting') this.attempt = 0;
        void this.dial();
    }

    /**
     * Close for good, without telling the agent to do anything: its sessions go
     * on running on the VM. For the app quitting.
     */
    public close(): void {
        if (this.phase === 'closed') return;
        const wasConnected = this.phase === 'connected';
        this.phase = 'closed';
        this.deps.timers.clearTimeout(this.retryTimer);
        this.deps.timers.clearTimeout(this.handshakeTimer);
        this.retryTimer = null;
        this.handshakeTimer = null;
        const link = this.link;
        this.link = null;
        link?.close();
        this.failRequests(new Error('the agent connection is closed'));
        this.failWaiters(new Error('the agent connection is closed'));
        if (wasConnected) this.disconnectedListeners.forEach((l) => l('closed'));
    }

    // ── Talking ──

    /** Send now, or drop it when the link is down. Answers whether it was sent. */
    public send(message: MacMessage): boolean {
        if (this.phase !== 'connected' || !this.link) return false;
        this.link.send(message);
        return true;
    }

    /** Pick a session's output up again after `since`; answered with `attached`, then the replay. */
    public attach(sessionId: string, since: number, cols: number, rows: number): boolean {
        return this.send({type: 'attach', sessionId, since, cols, rows});
    }

    /** Start (or attach to) a session on the agent. */
    public async open(spec: OpenSpec): Promise<OpenedMessage> {
        return this.request<OpenedMessage>('opened', (requestId) => ({type: 'open', requestId, ...spec}));
    }

    public async listSessions(): Promise<AgentSessionInfo[]> {
        const reply = await this.request<Extract<AgentMessage, {type: 'sessions'}>>('sessions', (requestId) => ({
            type: 'list-sessions',
            requestId,
        }));
        return reply.sessions;
    }

    public async getHostSettings(): Promise<HostSettings> {
        const reply = await this.request<Extract<AgentMessage, {type: 'host-settings'}>>(
            'host-settings',
            (requestId) => ({type: 'get-host-settings', requestId}),
        );
        this.hostSettings = reply.settings;
        return reply.settings;
    }

    public async setHostSettings(settings: Partial<HostSettings>): Promise<HostSettings> {
        const reply = await this.request<Extract<AgentMessage, {type: 'host-settings'}>>(
            'host-settings',
            (requestId) => ({type: 'set-host-settings', requestId, settings}),
        );
        this.hostSettings = reply.settings;
        return reply.settings;
    }

    public async checkTools(): Promise<{tools: ToolCheck[]; sudo: boolean}> {
        const reply = await this.request<Extract<AgentMessage, {type: 'tools'}>>('tools', (requestId) => ({
            type: 'check-tools',
            requestId,
        }));
        return {tools: reply.tools, sudo: reply.sudo};
    }

    public async copyConfig(files: ConfigFile[], removed: string[]): Promise<DoneMessage> {
        return this.request<DoneMessage>('done', (requestId) => ({type: 'copy-config', requestId, files, removed}));
    }

    /**
     * Send a request once connected and wait for its answer.
     *
     * Rejects when the link cannot be had, when it drops before the answer, or
     * when the answer takes longer than the timeout. A reply of another type
     * than expected is a protocol slip and rejects too.
     */
    private async request<T extends AgentMessage>(
        expect: T['type'],
        build: (requestId: string) => MacMessage,
    ): Promise<T> {
        await this.whenConnected();
        const link = this.link;
        if (!link) throw new Error('the agent link dropped');
        const requestId = `r${++this.nextRequest}`;
        const timeoutMs = this.deps.requestTimeoutMs ?? AGENT_REQUEST_TIMEOUT_MS;
        return new Promise<T>((resolve, reject) => {
            const timer = this.deps.timers.setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`the agent did not answer within ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            this.pending.set(requestId, {
                resolve: (message) => {
                    if (message.type !== expect) reject(new Error(`expected ${expect}, got ${message.type}`));
                    else resolve(message as T);
                },
                reject,
                timer,
            });
            link.send(build(requestId));
        });
    }

    // ── The link ──

    private async dial(): Promise<void> {
        const {dialer, host, log} = this.deps;
        this.phase = 'dialing';
        this.setStatus({
            phase: 'connecting',
            target: this.target,
            ...(this.attempt ? {attempt: this.attempt, maxAttempts: MAX_RETRIES} : {}),
        });

        let link: AgentLink;
        try {
            link = await dialer.dial(host);
        } catch (err) {
            if (this.phase !== 'dialing') return;
            log.warn(`[agent] ${this.target} could not dial: ${(err as Error).message}`);
            this.lost((err as Error).message, false);
            return;
        }
        // Closed while ssh was starting.
        if (this.phase !== 'dialing') {
            link.close();
            return;
        }

        this.link = link;
        this.phase = 'handshaking';
        link.onMessage((message) => this.receive(link, message));
        link.onOutput((output) => {
            if (link === this.link && this.phase === 'connected') this.outputListeners.forEach((l) => l(output));
        });
        link.onClose((reason) => {
            if (link !== this.link) return;
            this.link = null;
            this.lost(reason, this.phase === 'connected');
        });

        this.handshakeTimer = this.deps.timers.setTimeout(() => {
            this.handshakeTimer = null;
            if (link !== this.link || this.phase !== 'handshaking') return;
            log.warn(`[agent] ${this.target} sent no welcome; closing`);
            link.close();
        }, this.deps.handshakeTimeoutMs ?? AGENT_HANDSHAKE_TIMEOUT_MS);

        link.send({type: 'hello', protocol: AGENT_PROTOCOL_VERSION, appVersion: this.deps.appVersion});
    }

    private receive(link: AgentLink, message: AgentMessage): void {
        if (link !== this.link) return;

        if (this.phase === 'handshaking') {
            if (message.type === 'welcome') {
                if (message.protocol !== AGENT_PROTOCOL_VERSION) {
                    link.send({type: 'bye', code: AGENT_CLOSE.versionMismatch});
                    this.needsReinstall(
                        `the agent speaks protocol ${message.protocol}, this app ${AGENT_PROTOCOL_VERSION}`,
                    );
                    return;
                }
                this.welcomed(message);
                return;
            }
            if (message.type === 'bye' && message.code === AGENT_CLOSE.versionMismatch) {
                this.needsReinstall(message.reason || 'the agent is a different version than the app');
                return;
            }
            this.deps.log.warn(`[agent] ${this.target} sent ${message.type} before welcome; closing`);
            this.lastReason = `unexpected ${message.type} before welcome`;
            link.close();
            return;
        }

        if (message.type === 'bye') {
            // The close follows; what it means (redial) is decided there.
            this.deps.log.info(
                `[agent] ${this.target} said bye: ${message.code}${message.reason ? ` (${message.reason})` : ''}`,
            );
            if (message.code === AGENT_CLOSE.versionMismatch) this.needsReinstall(message.reason || message.code);
            return;
        }
        if ('requestId' in message) {
            const pending = this.pending.get(message.requestId);
            if (!pending) return;
            this.pending.delete(message.requestId);
            this.deps.timers.clearTimeout(pending.timer);
            pending.resolve(message);
            return;
        }
        if (message.type === 'welcome') return;
        this.messageListeners.forEach((l) => l(message));
    }

    private welcomed(welcome: WelcomeMessage): void {
        const {timers, clock, log} = this.deps;
        timers.clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.phase = 'connected';
        this.hostSettings = welcome.settings;
        this.everConnected = true;
        this.connectedAt = clock.now();
        this.lastReason = '';
        log.info(`[agent] ${this.target} connected, agent ${welcome.agentVersion}`);
        this.setStatus({phase: 'connected', target: this.target});

        const waiters = this.waiters;
        this.waiters = [];
        waiters.forEach((w) => w.resolve());
        this.connectedListeners.forEach((l) => l(this));
    }

    /**
     * The link is gone, or never came up. Decide whether to dial again.
     *
     * `wasConnected` says the handshake had finished, so listeners holding
     * per-link state (held questions) have to let it go.
     */
    private lost(reason: string, wasConnected: boolean): void {
        const {timers, clock, log} = this.deps;
        timers.clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        if (this.phase === 'closed' || this.phase === 'needs-reinstall') {
            this.failRequests(new Error(this.lastReason || reason));
            if (wasConnected) this.disconnectedListeners.forEach((l) => l(reason));
            return;
        }

        const lasted = wasConnected ? clock.now() - this.connectedAt : 0;
        log.info(`[agent] ${this.target} link lost after ${Math.round(lasted / 1000)}s: ${reason}`);
        this.failRequests(new Error(`the agent link dropped: ${reason}`));
        if (wasConnected) this.disconnectedListeners.forEach((l) => l(reason));

        if (AGENT_MISSING.test(reason)) {
            this.needsReinstall('the agent is not installed on this host');
            return;
        }
        if (isFatalSshOutput(reason)) {
            this.giveUp(reason);
            return;
        }
        // A link that stood for a while was genuinely working, so the next break
        // starts the ladder over rather than inheriting the previous attempts.
        if (lasted >= REMOTE_STABLE_MS) this.attempt = 0;
        this.attempt += 1;
        if (this.attempt > MAX_RETRIES) {
            this.giveUp(reason);
            return;
        }

        const delayMs = remoteRetryDelay(this.attempt);
        this.phase = 'waiting';
        this.lastReason = reason;
        this.setStatus({
            phase: 'retrying',
            target: this.target,
            reason,
            attempt: this.attempt,
            maxAttempts: MAX_RETRIES,
            delayMs,
            everConnected: this.everConnected,
        });
        this.retryTimer = timers.setTimeout(() => {
            this.retryTimer = null;
            if (this.phase === 'waiting') void this.dial();
        }, delayMs);
    }

    private giveUp(reason: string): void {
        this.deps.log.warn(`[agent] ${this.target} giving up: ${reason}`);
        this.phase = 'failed';
        this.lastReason = reason;
        this.setStatus({
            phase: 'failed',
            target: this.target,
            reason,
            attempts: Math.min(this.attempt, MAX_RETRIES),
            everConnected: this.everConnected,
        });
        this.failWaiters(new Error(reason));
    }

    /** Stop dialling: a redial would be refused the same way until the agent is reinstalled. */
    private needsReinstall(reason: string): void {
        if (this.phase === 'needs-reinstall') return;
        this.deps.log.warn(`[agent] ${this.target} needs a reinstall: ${reason}`);
        this.deps.timers.clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        const wasConnected = this.phase === 'connected';
        this.phase = 'needs-reinstall';
        this.lastReason = reason;
        const link = this.link;
        this.link = null;
        link?.close();
        this.setStatus({phase: 'failed', target: this.target, reason, everConnected: this.everConnected});
        this.failRequests(new Error(reason));
        this.failWaiters(new Error(reason));
        if (wasConnected) this.disconnectedListeners.forEach((l) => l(reason));
        this.reinstallListeners.forEach((l) => l(reason));
    }

    private setStatus(status: RemoteStatusPayload): void {
        this.lastStatus = status;
        this.statusListeners.forEach((l) => l(status));
    }

    private failRequests(error: Error): void {
        for (const [, pending] of this.pending) {
            this.deps.timers.clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private failWaiters(error: Error): void {
        const waiters = this.waiters;
        this.waiters = [];
        waiters.forEach((w) => w.reject(error));
    }
}
