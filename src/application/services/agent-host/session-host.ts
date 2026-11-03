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
 */
import {buildClaudeCommand} from '../../../domain/launch/claude-command';
import {claudeSessionEnv, plainTerminalEnv} from '../../../domain/launch/terminal-env';
import {withHostInstructions} from '../../../domain/agent/host-instructions';
import {shellArgs} from '../../../domain/shell/quoting';
import {Scrollback} from './scrollback';
import type {ClientLink} from '../../ports/agent-link';
import type {GitWorkspace} from '../../ports/git-workspace';
import type {Logger} from '../../ports/logger';
import type {Timers} from '../../ports/clock';
import type {PtyHandle, TerminalGateway} from '../../ports/terminal-gateway';
import type {
    AgentSessionInfo,
    AgentSessionKind,
    AttachMessage,
    HostSettings,
    OpenSessionMessage,
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
    private readonly opening = new Map<string, Promise<void>>();

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
        }
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

        const started = this.start(client, message).finally(() => this.opening.delete(message.sessionId));
        this.opening.set(message.sessionId, started);
        await started;
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

    private async start(client: ClientLink, message: OpenSessionMessage): Promise<void> {
        const {sessionId, requestId} = message;
        const cwd = expandHome(message.dir, this.deps.home);

        let pty: PtyHandle;
        try {
            pty =
                message.kind === 'claude'
                    ? await this.spawnClaude(sessionId, cwd, message)
                    : this.spawnShell(cwd, message);
        } catch (err) {
            this.deps.log.warn(`[agent] open ${sessionId} failed: ${(err as Error).message}`);
            client.send({type: 'opened', requestId, ok: false, error: (err as Error).message});
            return;
        }

        const session: HostedSession = {
            kind: message.kind,
            cwd,
            pty,
            alive: true,
            scrollback: new Scrollback(),
            clients: new Set(),
        };
        // A fresh start replaces whatever an earlier run of the same id left behind.
        this.sessions.delete(sessionId);
        this.sessions.set(sessionId, session);
        this.wire(sessionId, session);

        client.send({type: 'opened', requestId, ok: true, reattached: false});
        session.clients.add(client);
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
            env: plainTerminalEnv(terminals.baseEnv),
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
        }));
    }

    /** Drop the oldest ended sessions past the limit; the map keeps start order. */
    private forgetOldEnded(): void {
        const ended = [...this.sessions].filter(([, session]) => !session.alive);
        for (const [sessionId] of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_SESSIONS))) {
            this.sessions.delete(sessionId);
        }
    }
}
