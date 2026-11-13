/**
 * The agent's sessions: their PTYs, their commands and their scrollback (#284).
 *
 * On a VM the agent is what a local launch is on the Mac. It spawns the real
 * process, builds the full `claude` command (launch options, resume, the
 * question hook and archive tool, the host instructions) and keeps the
 * output, numbered, for whichever client comes back for it. The Mac's side
 * of a session is only a stand-in PTY forwarding over the link.
 *
 * A session belongs to the machine, not to a client. It keeps running with no
 * client at all, which is the point of offloading work to a VM, and a client
 * going away only stops what is sent to it.
 *
 * The agent may also start a session by itself (#438), with no client: the
 * Merge manager's fix errands, while the VM is the Merging host. Such a
 * session is the same PTY session as one a client opened, so the Mac can
 * attach to it later. Each one is recorded (SELF_STARTED_FILE) until a Mac
 * has caught up on it (`list-self-started`, then `forget-self-started`), so
 * the Mac can show it as started while it was away even after an agent
 * restart. In-process services hear every session's end through `onExit`.
 */
import {buildClaudeCommand} from '../../../domain/launch/claude-command';
import {claudeSessionEnv} from '../../../domain/launch/terminal-env';
import {withHostInstructions} from '../../../domain/agent/host-instructions';
import {shellArgs} from '../../../domain/shell/quoting';
import {Scrollback} from './scrollback';
import type {ClientLink} from '../../ports/agent-link';
import type {GitWorkspace} from '../../ports/git-workspace';
import type {Logger} from '../../ports/logger';
import type {Clock, Timers} from '../../ports/clock';
import type {RecordFile} from '../../ports/record-file';
import type {PtyHandle, TerminalGateway} from '../../ports/terminal-gateway';
import type {
    AgentSessionInfo,
    AgentSessionKind,
    AttachMessage,
    ForgetSelfStartedMessage,
    HostSettings,
    OpenSessionMessage,
    SelfStartedSession,
    SignalMessage,
} from '../../../domain/agent/protocol';
import type {SessionOptions} from '../../../domain/launch/session-options';
import type {HookForwarderPart, SessionHostMessage, SessionHostPart} from './handlers';

/**
 * How long a shell gets to come up before its `command` is typed in.
 *
 * As for a local plain terminal: zsh reads no startup variable a command could
 * ride in on, so it is typed once the shell is accepting input.
 */
export const SHELL_COMMAND_DELAY_MS = 300;

/**
 * How many ended sessions are remembered, newest first.
 *
 * An ended session is kept so a client coming back can still read what it
 * printed while nobody watched, but each one holds up to a full scrollback,
 * and an agent that runs for months must not keep them all.
 */
export const MAX_ENDED_SESSIONS = 50;

/** The terminal size a self-started session gets until a client attaches and resizes it. */
export const SELF_STARTED_SIZE = {cols: 120, rows: 40} as const;

/** What an agent-side service asks for when it starts a session by itself. */
export interface SelfStartRequest {
    /** The new session's id; the caller makes it, as the Mac does for an `open`. */
    sessionId: string;
    /** Where it runs on the VM; `~` is expanded. */
    dir: string;
    /** Its launch options, `initialPrompt` included. */
    options?: SessionOptions;
    /** A fix errand of the Merge manager. */
    errand?: boolean;
}

export type SelfStartResult = {ok: true} | {ok: false; error: string};

/** Told when a session's process ends, whoever started it. */
export type SessionExitListener = (sessionId: string, exitCode: number) => void;

export interface SessionHostDeps {
    terminals: TerminalGateway;
    /** The VM user's login shell, as an absolute path. */
    loginShell: string;
    /** The hook settings and archive tool for a launch. */
    hooks: Pick<HookForwarderPart, 'settingsFor' | 'toolsFor'>;
    /** The host's settings as they are now, read at every launch. */
    hostSettings: () => HostSettings;
    /** Tells whether a folder is in a git repository, which `--worktree` needs. */
    git: Pick<GitWorkspace, 'worktreeRoot'>;
    /** The VM user's home folder, for `~` in a session's directory. */
    home: string;
    /** Where self-started sessions are recorded until a Mac catches up on them. */
    selfStarted: RecordFile;
    /** For a self-started session's `startedAt`. */
    clock: Clock;
    timers: Timers;
    log: Logger;
}

/** One session the agent holds. */
interface HostedSession {
    kind: AgentSessionKind;
    cwd: string;
    pty: PtyHandle;
    alive: boolean;
    scrollback: Scrollback;
    /** The clients that opened or attached to it, and so get its output. */
    clients: Set<ClientLink>;
    /** Started by the agent itself (#438). */
    selfStarted?: boolean;
    /** A fix errand of the Merge manager (#438). */
    errand?: boolean;
}

/**
 * A session's directory with a leading `~` made absolute: empty or `~` is the
 * home folder, `~/x` is under it. `~user` and anything else are left alone.
 */
export function expandHome(dir: string, home: string): string {
    if (dir === '' || dir === '~') return home;
    if (dir.startsWith('~/')) return home.replace(/\/+$/, '') + dir.slice(1);
    return dir;
}

/** The launch options without `--worktree`, for a folder that is not in a git repository. */
export function withoutWorktree(options: SessionOptions): SessionOptions {
    const {worktree: _worktree, worktreeName: _worktreeName, ...rest} = options;
    return rest;
}

export class SessionHost implements SessionHostPart {
    private readonly sessions = new Map<string, HostedSession>();
    /** Opens still waiting on the git check, so a second open for the same id waits rather than spawning twice. */
    private readonly opening = new Map<string, Promise<unknown>>();
    private readonly exitListeners: SessionExitListener[] = [];

    constructor(private readonly deps: SessionHostDeps) {}

    public clientConnected(_client: ClientLink): void {
        // A client gets nothing until it opens or attaches to a session.
    }

    /** Stop sending to a client; its sessions keep running. */
    public clientGone(client: ClientLink): void {
        for (const session of this.sessions.values()) session.clients.delete(client);
    }

    public handle(client: ClientLink, message: SessionHostMessage): void {
        switch (message.type) {
            case 'open':
                void this.open(client, message);
                return;
            case 'attach':
                this.attach(client, message);
                return;
            case 'input':
                this.liveSession(message.sessionId)?.pty.write(message.data);
                return;
            case 'resize':
                this.resize(message.sessionId, message.cols, message.rows);
                return;
            case 'signal':
                this.signal(message);
                return;
            case 'list-sessions':
                client.send({type: 'sessions', requestId: message.requestId, sessions: this.list()});
                return;
            case 'list-self-started':
                client.send({type: 'self-started', requestId: message.requestId, sessions: this.readRecords()});
                return;
            case 'forget-self-started':
                this.forget(client, message);
                return;
        }
    }

    /**
     * Start a Claude session with no client (#438), for an agent-side service
     * such as the Merge manager's fix errands. It runs exactly as one a client
     * opened, is recorded for the Mac to catch up on, and a client may attach
     * to it later by its id. An id already running is refused: the caller
     * makes a fresh id for every session it starts.
     */
    public async startSelf(request: SelfStartRequest): Promise<SelfStartResult> {
        const {sessionId} = request;
        if (this.liveSession(sessionId) || this.opening.has(sessionId)) {
            return {ok: false, error: `session ${sessionId} is already running`};
        }
        const message: OpenSessionMessage = {
            type: 'open',
            requestId: '',
            sessionId,
            kind: 'claude',
            dir: request.dir,
            isNew: true,
            ...SELF_STARTED_SIZE,
            ...(request.options ? {options: request.options} : {}),
        };
        const started = this.start(message, {selfStarted: true, errand: request.errand}).finally(() =>
            this.opening.delete(sessionId),
        );
        this.opening.set(sessionId, started);
        const result = await started;
        if (result.ok) this.record(sessionId, request.errand === true);
        return result;
    }

    /** Hear every session's end, in-process, whether or not a client is connected (#438). */
    public onExit(listener: SessionExitListener): void {
        this.exitListeners.push(listener);
    }

    /** Whether a session by that id is running now. */
    public isAlive(sessionId: string): boolean {
        return this.liveSession(sessionId) !== undefined;
    }

    /**
     * Stop one session as the Mac's stop does: SIGTERM to its whole tree. For an
     * archive the session asked for while no Mac was connected (#308). Answers
     * whether a live session by that id was there to stop.
     */
    public stop(sessionId: string): boolean {
        const session = this.liveSession(sessionId);
        if (!session) return false;
        this.signalSession(session, 'SIGTERM');
        return true;
    }

    /** Signal every live session, for an orderly shutdown. */
    public terminateAll(): void {
        for (const session of this.sessions.values()) {
            if (session.alive) this.signalSession(session, 'SIGTERM');
        }
    }

    private async open(client: ClientLink, message: OpenSessionMessage): Promise<void> {
        // A loop, not one wait: when the open waited on fails, the next waiter
        // in line starts its own, and this one must wait on that in turn.
        for (
            let pending = this.opening.get(message.sessionId);
            pending;
            pending = this.opening.get(message.sessionId)
        ) {
            await pending;
        }

        const existing = this.liveSession(message.sessionId);
        if (existing) {
            this.reattach(client, message, existing);
            return;
        }

        const started = this.start(message, {}).finally(() => this.opening.delete(message.sessionId));
        this.opening.set(message.sessionId, started);
        const outcome = await started;
        const {requestId} = message;
        client.send(
            outcome.ok
                ? {type: 'opened', requestId, ok: true, reattached: false}
                : {type: 'opened', requestId, ok: false, error: outcome.error},
        );
        // Only after `opened`, so the client never gets output before the answer.
        if (outcome.ok) this.sessions.get(message.sessionId)?.clients.add(client);
    }

    /**
     * An open for a session that is already running is an attach: the client
     * gets everything still kept, then the live stream.
     */
    private reattach(client: ClientLink, message: OpenSessionMessage, session: HostedSession): void {
        client.send({type: 'opened', requestId: message.requestId, ok: true, reattached: true});
        this.resize(message.sessionId, message.cols, message.rows);
        this.replay(client, message.sessionId, session, -1);
        session.clients.add(client);
    }

    /**
     * Spawn a session and keep it, with no client yet; answers whether it
     * started. The caller adds the client that opened it, if any.
     */
    private async start(
        message: OpenSessionMessage,
        origin: Pick<HostedSession, 'selfStarted' | 'errand'>,
    ): Promise<SelfStartResult> {
        const {sessionId} = message;
        const cwd = expandHome(message.dir, this.deps.home);

        let pty: PtyHandle;
        try {
            pty =
                message.kind === 'claude'
                    ? await this.spawnClaude(sessionId, cwd, message)
                    : this.spawnShell(cwd, message);
        } catch (err) {
            this.deps.log.warn(`[agent] open ${sessionId} failed: ${(err as Error).message}`);
            return {ok: false, error: (err as Error).message};
        }

        const session: HostedSession = {
            kind: message.kind,
            cwd,
            pty,
            alive: true,
            scrollback: new Scrollback(),
            clients: new Set(),
            ...(origin.selfStarted ? {selfStarted: true} : {}),
            ...(origin.errand ? {errand: true} : {}),
        };
        // A fresh start replaces whatever an earlier run of the same id left behind.
        this.sessions.delete(sessionId);
        this.sessions.set(sessionId, session);
        this.wire(sessionId, session);

        return {ok: true};
    }

    /**
     * Start `claude` as a local launch would, with the host instructions after
     * the project's own appended prompt and the agent's own hooks and tools.
     *
     * @throws when the command cannot be built or the PTY cannot be spawned.
     */
    private async spawnClaude(sessionId: string, cwd: string, message: OpenSessionMessage): Promise<PtyHandle> {
        const {terminals, hooks, git, log, loginShell} = this.deps;
        let options = message.options;

        // `--worktree` fails outright outside a git repository, so such a folder
        // starts without it rather than not at all.
        if (message.isNew && options?.worktree && !(await git.worktreeRoot(cwd))) {
            log.info(`[agent] ${cwd} is not a git repository; starting without --worktree`);
            options = withoutWorktree(options);
        }

        const command = buildClaudeCommand({
            target: {sessionId, isNew: message.isNew},
            options: {
                ...options,
                appendSystemPrompt: withHostInstructions(
                    options?.appendSystemPrompt,
                    this.deps.hostSettings().instructions,
                ),
            },
            settings: hooks.settingsFor(sessionId) ?? undefined,
            tools: hooks.toolsFor(sessionId) ?? undefined,
        });

        return terminals.spawn({
            file: loginShell,
            args: shellArgs(loginShell, command),
            cwd,
            cols: message.cols,
            rows: message.rows,
            env: claudeSessionEnv(terminals.baseEnv),
        });
    }

    /** Start a login shell, typing `command` into it once it is up. */
    private spawnShell(cwd: string, message: OpenSessionMessage): PtyHandle {
        const {terminals, timers, loginShell} = this.deps;
        const pty = terminals.spawn({
            file: loginShell,
            args: shellArgs(loginShell),
            cwd,
            cols: message.cols,
            rows: message.rows,
            // Not plainTerminalEnv: its `claude` shim (through ENV/BASH_ENV) is
            // for the Mac's terminals, and here it would shadow the real
            // `claude` the setup script installs and signs in to.
            env: claudeSessionEnv(terminals.baseEnv),
        });

        const command = message.command;
        if (command) {
            timers.setTimeout(() => {
                if (pty.disposed) return;
                try {
                    pty.write(command + '\n');
                } catch {
                    // The shell exited between the check and the write.
                }
            }, SHELL_COMMAND_DELAY_MS);
        }
        return pty;
    }

    /** Number and keep the output, and forward it to the session's clients; tell them when it ends. */
    private wire(sessionId: string, session: HostedSession): void {
        session.pty.onData((data) => {
            const {seq} = session.scrollback.append(data);
            for (const client of session.clients) client.sendOutput({sessionId, seq, data});
        });
        session.pty.onExit(({exitCode, signal}) => {
            if (!session.alive) return;
            session.alive = false;
            for (const client of session.clients) {
                client.send({type: 'exited', sessionId, exitCode, ...(signal === undefined ? {} : {signal})});
            }
            session.clients.clear();
            this.forgetOldEnded();
            for (const listener of this.exitListeners) {
                try {
                    listener(sessionId, exitCode);
                } catch (err) {
                    this.deps.log.error(`[agent] an exit listener failed for ${sessionId}`, err);
                }
            }
        });
    }

    /**
     * Pick a session's output up again from `since`.
     *
     * An ended session still replays what it printed, so a client that was away
     * sees how it ended; only a live one adds the client to its stream.
     */
    private attach(client: ClientLink, message: AttachMessage): void {
        const {sessionId} = message;
        const session = this.sessions.get(sessionId);
        if (!session) {
            client.send({type: 'attached', sessionId, alive: false, reset: false});
            return;
        }
        const replay = session.scrollback.since(message.since);
        client.send({type: 'attached', sessionId, alive: session.alive, reset: replay.reset});
        for (const chunk of replay.chunks) client.sendOutput({sessionId, ...chunk});
        if (session.alive) {
            this.resize(sessionId, message.cols, message.rows);
            session.clients.add(client);
        }
    }

    private replay(client: ClientLink, sessionId: string, session: HostedSession, since: number): void {
        for (const chunk of session.scrollback.since(since).chunks) client.sendOutput({sessionId, ...chunk});
    }

    private resize(sessionId: string, cols: number, rows: number): void {
        const session = this.liveSession(sessionId);
        if (!session || cols <= 0 || rows <= 0) return;
        try {
            session.pty.resize(cols, rows);
        } catch {
            // The process exited between the check and the resize.
        }
    }

    private signal(message: SignalMessage): void {
        const session = this.liveSession(message.sessionId);
        if (session) this.signalSession(session, message.signal);
    }

    /** The whole tree, so a preLaunchCmd wrapper does not leave `claude` running; the process alone when that fails. */
    private signalSession(session: HostedSession, signal: NodeJS.Signals): void {
        if (this.deps.terminals.signalTree(session.pty, signal)) return;
        try {
            session.pty.kill(signal);
        } catch {
            // Already gone.
        }
    }

    private liveSession(sessionId: string): HostedSession | undefined {
        const session = this.sessions.get(sessionId);
        return session?.alive ? session : undefined;
    }

    private list(): AgentSessionInfo[] {
        return [...this.sessions].map(([sessionId, session]) => ({
            sessionId,
            kind: session.kind,
            cwd: session.cwd,
            alive: session.alive,
            lastSeq: session.scrollback.lastSeq,
            ...(session.selfStarted ? {selfStarted: true} : {}),
            ...(session.errand ? {errand: true} : {}),
        }));
    }

    /** Add a self-started session to the record; a failed write is logged, the session runs on. */
    private record(sessionId: string, errand: boolean): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        const records = this.readRecords().filter((entry) => entry.sessionId !== sessionId);
        records.push({
            sessionId,
            cwd: session.cwd,
            startedAt: this.deps.clock.now(),
            ...(errand ? {errand: true} : {}),
        });
        try {
            this.writeRecords(records);
        } catch (err) {
            this.deps.log.error(`[agent] could not record self-started session=${sessionId}`, err);
        }
    }

    /** Drop the sessions the Mac has handled from the record; answered with `done`. */
    private forget(client: ClientLink, message: ForgetSelfStartedMessage): void {
        const forgotten = new Set(message.sessionIds);
        const records = this.readRecords();
        const kept = records.filter((entry) => !forgotten.has(entry.sessionId));
        try {
            if (kept.length !== records.length) this.writeRecords(kept);
            client.send({type: 'done', requestId: message.requestId, ok: true});
        } catch (err) {
            client.send({type: 'done', requestId: message.requestId, ok: false, error: (err as Error).message});
        }
    }

    /**
     * The self-started record. A missing, unreadable or malformed file reads
     * as empty, and malformed entries are skipped: it is a convenience for the
     * Mac's rows and must never stop a session from starting.
     */
    private readRecords(): SelfStartedSession[] {
        const text = this.deps.selfStarted.read();
        if (!text) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            this.deps.log.warn('[agent] the self-started record is not JSON; reading it as empty');
            return [];
        }
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (entry): entry is SelfStartedSession =>
                typeof entry === 'object' &&
                entry !== null &&
                typeof (entry as SelfStartedSession).sessionId === 'string' &&
                typeof (entry as SelfStartedSession).cwd === 'string' &&
                typeof (entry as SelfStartedSession).startedAt === 'number',
        );
    }

    private writeRecords(records: SelfStartedSession[]): void {
        this.deps.selfStarted.write(JSON.stringify(records, null, 2) + '\n');
    }

    /** Drop the oldest ended sessions past the limit; the map keeps start order. */
    private forgetOldEnded(): void {
        const ended = [...this.sessions].filter(([, session]) => !session.alive);
        for (const [sessionId] of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_SESSIONS))) {
            this.sessions.delete(sessionId);
        }
    }
}
