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
    AgentToolName,
    AgentTranscript,
    ConfigFile,
    CopyStateMessage,
    DoneMessage,
    FileContentMessage,
    FileStatsMessage,
    HandoffDoneMessage,
    HandoffMessage,
    HostSettings,
    MacMessage,
    OpenedMessage,
    OpenSessionMessage,
    TerminalOutput,
    ToolCheck,
    ToolResultMessage,
    TranscriptAnswerMessage,
    TranscriptListMessage,
    TranscriptMessage,
    TranscriptQueryMethod,
    TranscriptTailReply,
    WelcomeMessage,
} from '../../../domain/agent/protocol';
import type {RemoteConfig} from '../../../domain/project/remote-target';
import type {RemoteStatusPayload} from '../../../domain/remote/remote-status';
import type {AgentDialer, AgentLink} from '../../ports/agent-link';
import type {Disposable} from '../../ports/git-workspace';
import type {Clock, TimerHandle, Timers} from '../../ports/clock';
import type {Logger} from '../../ports/logger';

/** How long a request may wait for its answer once sent. */
export const AGENT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a `handoff` may run (#276 stage 2). A clone of a large repository
 * over the VM's own network, then the bundle, the patch and the files, takes
 * minutes, not seconds; the progress lines show it is alive meanwhile.
 */
export const AGENT_HANDOFF_TIMEOUT_MS = 20 * 60_000;

/** How long an upload's `upload-end` may wait: the agent checks the whole file's hash first. */
export const AGENT_UPLOAD_TIMEOUT_MS = 2 * 60_000;

/** How long a `push-branch` may take: a push over the VM's network, hooks and all. */
export const AGENT_PUSH_TIMEOUT_MS = 5 * 60_000;

/**
 * The raw bytes one `upload-chunk` carries. Base64 makes that a third larger
 * (about 5.3 MB), comfortably under the 16 MB frame cap with the JSON around it.
 */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

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

/** A `handoff` as the service asks for it; the request id is the connection's business. */
export type HandoffSpec = Omit<HandoffMessage, 'type' | 'requestId'>;

/** Messages the agent sends unasked, which the connection hands on. */
export type UnaskedMessage = Exclude<AgentMessage, {requestId: string} | WelcomeMessage | {type: 'bye'}>;

/**
 * How much longer than its own timeout a `run-tool` may wait for its answer:
 * the agent kills the tool at `timeoutMs` and still has to say so.
 */
export const RUN_TOOL_GRACE_MS = 5_000;

/** What a `run-tool` produced, decoded. */
export interface ToolRun {
    /** The exit code; -1 when the tool could not start or timed out. */
    code: number;
    stdout: Buffer;
    /** The last part of stderr. */
    stderr: string;
    /** stdout passed TOOL_OUTPUT_CAP_BYTES and was cut. */
    truncated: boolean;
}

/** A live `watch-dir`, kept so a reconnect can ask for it again. */
interface DirWatch {
    dir: string;
    onChange: () => void;
}

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
    private remoteAgentVersion: string | null = null;

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
    private nextUpload = 0;
    private nextWatch = 0;
    private agentHome: string | null = null;
    /**
     * The folder watches asked for and not disposed, by watch id. The agent
     * forgets its watches with the link, so every (re)connect asks again.
     */
    private readonly watches = new Map<string, DirWatch>();
    /** The progress listeners of running requests (`handoff`), by request id. */
    private readonly progress = new Map<string, (line: string) => void>();

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
    /** The version of the agent on the other end, from the last `welcome`; null before one. */
    public get agentVersion(): string | null {
        return this.remoteAgentVersion;
    }

    /**
     * The agent user's home folder, from the last `welcome`; null before one,
     * or from an agent older than stage 4. What a `~` path on the VM means.
     */
    public get home(): string | null {
        return this.agentHome;
    }

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

    // ── Project copies (stage 2) ──

    /**
     * Upload a file too large for one frame (a git bundle, a patch): `upload-begin`,
     * the bytes in `chunkBytes` chunks, then `upload-end` with its SHA-256, which
     * the agent checks before it answers `done`. Answers the upload id for a
     * `handoff` to name; rejects when the agent refuses it or the link drops.
     *
     * The hash comes from the caller (`HandoffGit` computes it as it reads the
     * file), so this layer needs no crypto of its own.
     */
    public async upload(
        bytes: Uint8Array,
        {sha256, chunkBytes = UPLOAD_CHUNK_BYTES}: {sha256: string; chunkBytes?: number},
    ): Promise<string> {
        await this.whenConnected();
        // Unique across app restarts too: an agent keeps an unused upload for a while.
        const uploadId = `u${this.deps.clock.now().toString(36)}-${++this.nextUpload}`;
        const step = Math.max(1, Math.floor(chunkBytes));
        const sent = (message: MacMessage) => {
            if (!this.send(message)) throw new Error('the agent link dropped during the upload');
        };
        sent({type: 'upload-begin', uploadId, size: bytes.length});
        for (let at = 0; at < bytes.length; at += step) {
            const chunk = bytes.subarray(at, Math.min(at + step, bytes.length));
            sent({type: 'upload-chunk', uploadId, dataBase64: Buffer.from(chunk).toString('base64')});
        }
        const done = await this.request<DoneMessage>(
            'done',
            (requestId) => ({type: 'upload-end', requestId, uploadId, sha256}),
            AGENT_UPLOAD_TIMEOUT_MS,
        );
        if (!done.ok) throw new Error(done.error || 'the agent refused the upload');
        return uploadId;
    }

    /**
     * Make or update a project's copy: send `handoff`, hand each of its
     * `handoff-progress` lines to `onProgress`, and answer its `handoff-done`.
     * Waits up to AGENT_HANDOFF_TIMEOUT_MS, since a clone is slow.
     */
    public async handoff(spec: HandoffSpec, onProgress?: (line: string) => void): Promise<HandoffDoneMessage> {
        return this.request<HandoffDoneMessage>(
            'handoff-done',
            (requestId) => ({type: 'handoff', requestId, ...spec}),
            AGENT_HANDOFF_TIMEOUT_MS,
            onProgress,
        );
    }

    /** Where a copy stands: its branch, unpushed commits and uncommitted paths. */
    public async copyStatus(dir: string): Promise<CopyStateMessage> {
        return this.request<CopyStateMessage>('copy-state', (requestId) => ({type: 'copy-status', requestId, dir}));
    }

    /** Push a copy's branch to origin from the VM. */
    public async pushBranch(dir: string, branch: string): Promise<DoneMessage> {
        return this.request<DoneMessage>(
            'done',
            (requestId) => ({type: 'push-branch', requestId, dir, branch}),
            AGENT_PUSH_TIMEOUT_MS,
        );
    }

    /** Delete a copy's folder on the VM; the agent refuses a folder it did not make. */
    public async removeCopy(dir: string): Promise<DoneMessage> {
        return this.request<DoneMessage>('done', (requestId) => ({type: 'remove-copy', requestId, dir}));
    }

    // ── Transcripts (stage 3) ──

    /**
     * A session's transcript as the VM parsed it: what its row is titled,
     * dated and searched by. Null when the VM has no transcript of that id yet,
     * or none worth listing. Asking also makes the agent watch that file, and
     * send `transcripts-changed` (through `onMessage`) when it changes.
     */
    public async getTranscript(sessionId: string): Promise<AgentTranscript | null> {
        const reply = await this.request<TranscriptMessage>('transcript', (requestId) => ({
            type: 'get-transcript',
            requestId,
            sessionId,
        }));
        return reply.transcript;
    }

    /**
     * The last `bytes` of a session's transcript, as lines: what PR watch and
     * task detection read a local transcript's tail for. Empty when the VM has
     * no transcript of that id.
     */
    public async transcriptTail(sessionId: string, bytes: number): Promise<string[]> {
        const reply = await this.request<TranscriptTailReply>('transcript-tail', (requestId) => ({
            type: 'transcript-tail',
            requestId,
            sessionId,
            bytes,
        }));
        return reply.lines;
    }

    /**
     * Put a transcript uploaded first (`upload`) where `claude --resume` on the
     * VM finds it, for a session handed off from the Mac. `dir` is the folder it
     * resumes in, as a project path names it. The agent refuses (`ok: false`)
     * when a transcript of that id is already there.
     */
    public async importTranscript(sessionId: string, dir: string, uploadId: string): Promise<DoneMessage> {
        return this.request<DoneMessage>('done', (requestId) => ({
            type: 'import-transcript',
            requestId,
            sessionId,
            dir,
            uploadId,
        }));
    }

    // ── The pages' git and files (stage 4) ──

    /**
     * Run `git` (as `git -C <cwd> …args`) or `gh` (in `cwd`) on the VM. `cwd`
     * is absolute there. Waits the tool's own `timeoutMs` plus a grace for the
     * answer. Rejects only when the link fails; a tool that fails answers its
     * code.
     */
    public async runTool(
        tool: AgentToolName,
        cwd: string,
        args: readonly string[],
        {stdin, timeoutMs}: {stdin?: string | Uint8Array; timeoutMs: number},
    ): Promise<ToolRun> {
        const reply = await this.request<ToolResultMessage>(
            'tool-result',
            (requestId) => ({
                type: 'run-tool',
                requestId,
                tool,
                cwd,
                args: [...args],
                ...(stdin !== undefined ? {stdinBase64: Buffer.from(stdin).toString('base64')} : {}),
                timeoutMs,
            }),
            timeoutMs + RUN_TOOL_GRACE_MS,
        );
        return {
            code: reply.code,
            stdout: Buffer.from(reply.stdoutBase64, 'base64'),
            stderr: reply.stderr,
            truncated: reply.truncated === true,
        };
    }

    /** A file's bytes on the VM (`path` absolute there); null when it is not there or is larger than `maxBytes`. */
    public async readFile(path: string, maxBytes: number): Promise<Buffer | null> {
        const reply = await this.request<FileContentMessage>('file-content', (requestId) => ({
            type: 'read-file',
            requestId,
            path,
            maxBytes,
        }));
        return reply.found ? Buffer.from(reply.contentBase64 ?? '', 'base64') : null;
    }

    /** The sizes of those paths on the VM that are regular files (never through a symlink). */
    public async statFiles(paths: readonly string[]): Promise<Map<string, number>> {
        const reply = await this.request<FileStatsMessage>('file-stats', (requestId) => ({
            type: 'stat-files',
            requestId,
            paths: [...paths],
        }));
        return new Map(Object.entries(reply.sizes));
    }

    /**
     * Watch a folder on the VM (`dir` absolute there): `onChange` on every
     * `dir-changed` the agent pushes for it, until disposed. Asked for at once
     * when connected, and again after every reconnect, since the agent drops its
     * watches with the link; a watch made while the link is down waits for it.
     * Never dials by itself: a page watching a host that is down should not
     * keep redialling it.
     */
    public watchDir(dir: string, onChange: () => void): Disposable {
        const watchId = `w${++this.nextWatch}`;
        this.watches.set(watchId, {dir, onChange});
        this.send({type: 'watch-dir', watchId, dir});
        return {
            dispose: () => {
                if (!this.watches.delete(watchId)) return;
                this.send({type: 'unwatch-dir', watchId});
            },
        };
    }

    /**
     * Ask the VM's transcript store one of its read methods; answers that
     * method's return value as the agent sent it (JSON). Rejects with the
     * agent's error when it refused or failed.
     */
    public async transcriptQuery(method: TranscriptQueryMethod, args: readonly unknown[]): Promise<unknown> {
        const reply = await this.request<TranscriptAnswerMessage>('transcript-answer', (requestId) => ({
            type: 'transcript-query',
            requestId,
            method,
            args: [...args],
        }));
        if (!reply.ok) throw new Error(reply.error || `the agent could not answer ${method}`);
        return reply.result;
    }

    /**
     * The sessions whose transcripts sit in `dirs` on the VM (as project paths
     * name them, `~` kept), or below one, newest first; only those modified
     * after `since` (epoch ms, the VM's clock) when given. How the Mac learns of
     * sessions it did not start, such as a schedule's run on the VM (stage 5).
     */
    public async listTranscripts(dirs: readonly string[], since?: number): Promise<TranscriptListMessage['sessions']> {
        const reply = await this.request<TranscriptListMessage>('transcript-list', (requestId) => ({
            type: 'list-transcripts',
            requestId,
            dirs: [...dirs],
            // The agent checks for an integer; an mtime may carry a fraction.
            ...(since === undefined ? {} : {since: Math.floor(since)}),
        }));
        return reply.sessions;
    }

    /**
     * Send a request once connected and wait for its answer.
     *
     * Rejects when the link cannot be had, when it drops before the answer, or
     * when the answer takes longer than the timeout. A reply of another type
     * than expected is a protocol slip and rejects too. `longTimeoutMs` gives a
     * slow request (a clone, a push) more time than the usual bound;
     * `onProgress` receives the request's `handoff-progress` lines until its
     * answer comes.
     */
    private async request<T extends AgentMessage>(
        expect: T['type'],
        build: (requestId: string) => MacMessage,
        longTimeoutMs?: number,
        onProgress?: (line: string) => void,
    ): Promise<T> {
        await this.whenConnected();
        const link = this.link;
        if (!link) throw new Error('the agent link dropped');
        const requestId = `r${++this.nextRequest}`;
        // A slow request (a clone, a push) gets its own, longer, bound.
        const timeoutMs = Math.max(this.deps.requestTimeoutMs ?? AGENT_REQUEST_TIMEOUT_MS, longTimeoutMs ?? 0);
        if (onProgress) this.progress.set(requestId, onProgress);
        return new Promise<T>((resolve, reject) => {
            const timer = this.deps.timers.setTimeout(() => {
                this.pending.delete(requestId);
                this.progress.delete(requestId);
                reject(new Error(`the agent did not answer within ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            this.pending.set(requestId, {
                resolve: (message) => {
                    this.progress.delete(requestId);
                    if (message.type !== expect) reject(new Error(`expected ${expect}, got ${message.type}`));
                    else resolve(message as T);
                },
                reject: (error) => {
                    this.progress.delete(requestId);
                    reject(error);
                },
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
        if (message.type === 'handoff-progress') {
            // A line of a running request, not its answer: the request stays pending.
            this.progress.get(message.requestId)?.(message.line);
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
        if (message.type === 'dir-changed') {
            // A watch disposed while this was on the way has nobody to tell.
            this.watches.get(message.watchId)?.onChange();
            return;
        }
        this.messageListeners.forEach((l) => l(message));
    }

    private welcomed(welcome: WelcomeMessage): void {
        const {timers, clock, log} = this.deps;
        timers.clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.phase = 'connected';
        this.hostSettings = welcome.settings;
        this.remoteAgentVersion = welcome.agentVersion;
        this.agentHome = welcome.home ?? null;
        this.everConnected = true;
        this.connectedAt = clock.now();
        this.lastReason = '';
        log.info(`[agent] ${this.target} connected, agent ${welcome.agentVersion}`);
        this.setStatus({phase: 'connected', target: this.target});
        // The agent kept no watches of the last link's; ask for them again.
        for (const [watchId, {dir}] of this.watches) this.send({type: 'watch-dir', watchId, dir});

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
