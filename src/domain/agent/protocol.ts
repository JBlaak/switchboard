/**
 * The wire protocol between Switchboard on the Mac and `switchboard-agent` on a
 * remote VM (epic #276).
 *
 * The agent runs a VM's sessions next to their code: it owns their PTYs, builds
 * their full `claude` command and keeps each one's scrollback for when the Mac
 * comes back. Everything else stays on the Mac. A session there is an ordinary
 * ActiveSession whose PTY is a stand-in forwarding over this link, so the
 * lifecycle, the OSC parsing, the sidebar, notifications and the phone work on
 * it unchanged. The agent's question hook server forwards what the CLI asks
 * back over the link to the Mac's QuestionService and archive tool, which are
 * the ones that answer.
 *
 * The link is a byte stream carried by ssh (the Mac runs
 * `switchboard-agent connect` on the VM, which bridges stdio to the agent's
 * Unix socket), cut into frames by `framing.ts`. A frame is either one JSON
 * message from this file or one chunk of terminal output.
 *
 * Trust is SSH's: whoever can run that command as the VM user may talk to the
 * agent, and the socket is 0600. Nothing in this file is about authentication.
 *
 * The agent is always installed at the app's own version, so a version
 * mismatch is not a screen for the user: the Mac closes with `versionMismatch`
 * and reinstalls.
 */
import type {SessionOptions} from '../launch/session-options';
import type {AskedQuestions, Question} from '../questions/question';
import type {ArchiveToolOutcome} from '../session/archive-tool';

/**
 * Bumped whenever a message changes shape in a way the other side would
 * misread. Adding an optional field, or a message the other side may ignore,
 * does not need a bump.
 */
export const AGENT_PROTOCOL_VERSION = 1;

/** Why one side ended the link, sent as `bye` before it closes. */
export const AGENT_CLOSE = {
    /** A malformed or unexpected frame. */
    protocolError: 'protocol-error',
    /** The versions differ; the Mac reinstalls the agent at its own version. */
    versionMismatch: 'version-mismatch',
    /** The agent is going away (upgrade, service stop). */
    shuttingDown: 'shutting-down',
} as const;

export type AgentCloseCode = (typeof AGENT_CLOSE)[keyof typeof AGENT_CLOSE];

// ── Shared shapes ──

/** What a session on the agent runs: Claude, or a plain login shell. */
export type AgentSessionKind = 'claude' | 'shell';

/** A session the agent holds, alive or ended but still remembered. */
export interface AgentSessionInfo {
    sessionId: string;
    kind: AgentSessionKind;
    /** The working directory on the VM, `~` already expanded. */
    cwd: string;
    alive: boolean;
    /** The last output chunk's sequence number; -1 before any output. */
    lastSeq: number;
}

/**
 * A host's own settings, stored on the agent because they are true of the
 * machine whichever client connects (Q5, Q9, Q19 in #276).
 */
export interface HostSettings {
    /** Appended to every Claude launch on this host, after the project's own appended prompt. */
    instructions: string;
    /** Whether the Mac copies its global `~/.claude` config here on every connect. */
    copyConfig: boolean;
    /** Where project copies go, e.g. `~/projects`. */
    baseFolder: string;
}

/** The tools the setup terminal installs and signs in to. */
export type AgentTool = 'claude' | 'gh' | 'git';

/** One tool's readiness on the VM, as the setup checks show it. */
export interface ToolCheck {
    tool: AgentTool;
    installed: boolean;
    version?: string;
    /** Signed in: `claude` has credentials, `gh auth status` passes. Absent for git, which has no login. */
    loggedIn?: boolean;
}

/** One file of the global config copy, relative to `~/.claude`. */
export interface ConfigFile {
    /** Relative to `~/.claude`, `/`-separated, never absolute and never containing `..`. */
    path: string;
    /** The file's bytes, base64. */
    contentBase64: string;
    /** POSIX mode bits, e.g. 0o644. */
    mode: number;
}

/**
 * Whether `path` may be written under `~/.claude` by the config copy: relative,
 * `/`-separated, no `.` or `..` segment, no empty segment, and not inside a
 * folder the copy never touches (credentials, transcripts and project memory,
 * MCP config). The agent checks every path again before it writes.
 */
export function isSafeConfigPath(path: string): boolean {
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
    return !NEVER_COPIED.some((never) => path === never || path.startsWith(never + '/'));
}

/** What the config copy never writes, whatever the Mac sends. */
export const NEVER_COPIED: readonly string[] = [
    '.credentials.json',
    'projects',
    'todos',
    'statsig',
    'shell-snapshots',
    'ide',
    '.claude.json',
    'settings.local.json',
];

// ── Mac → agent ──

/** The first message on every link; the agent answers `welcome` or `bye`. */
export interface HelloMessage {
    type: 'hello';
    protocol: number;
    /** The app's version, which the agent's own must equal. */
    appVersion: string;
}

/**
 * Start a session, or attach to it when the agent already has it alive.
 *
 * The agent builds the command itself: for `claude`, the same arguments a
 * local launch gets (`options`, `--session-id`/`--resume`, its own question
 * hook and archive tool), with the host instructions appended after
 * `options.appendSystemPrompt`. Answered with `opened`; output follows as
 * frames from sequence 0.
 */
export interface OpenSessionMessage {
    type: 'open';
    requestId: string;
    sessionId: string;
    kind: AgentSessionKind;
    /** The project's directory on the VM as the project path names it; may start with `~`. Empty means home. */
    dir: string;
    isNew: boolean;
    options?: SessionOptions;
    /**
     * For a `shell` only: a command the agent types into the shell once it is up,
     * as the setup terminal runs its setup script. Ignored for `claude`.
     */
    command?: string;
    cols: number;
    rows: number;
}

/**
 * Pick up a session's output again after the link came back.
 *
 * The agent answers `attached`, then replays every chunk after `since` that it
 * still holds. When it no longer holds `since + 1`, `attached.reset` is true:
 * the Mac clears the terminal and the replay starts from the oldest chunk kept.
 */
export interface AttachMessage {
    type: 'attach';
    sessionId: string;
    /** The last sequence number the Mac has shown; -1 for everything. */
    since: number;
    cols: number;
    rows: number;
}

export interface InputMessage {
    type: 'input';
    sessionId: string;
    data: string;
}

export interface ResizeMessage {
    type: 'resize';
    sessionId: string;
    cols: number;
    rows: number;
}

/** Signal the session's whole process tree, as the local TerminalGateway's `signalTree` does. */
export interface SignalMessage {
    type: 'signal';
    sessionId: string;
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP';
}

/** Which sessions the agent holds; answered with `sessions`. */
export interface ListSessionsMessage {
    type: 'list-sessions';
    requestId: string;
}

/** The answer to a forwarded `ask`, exactly the JSON the hook replies to the CLI with. */
export interface AskReplyMessage {
    type: 'ask-reply';
    hookId: string;
    json: Record<string, unknown>;
}

/** The answer to a forwarded `archive-request`. */
export interface ArchiveReplyMessage {
    type: 'archive-reply';
    hookId: string;
    outcome: ArchiveToolOutcome;
}

/** Read the host's settings; answered with `host-settings`. */
export interface GetHostSettingsMessage {
    type: 'get-host-settings';
    requestId: string;
}

/** Change some of the host's settings; answered with `host-settings` holding all of them. */
export interface SetHostSettingsMessage {
    type: 'set-host-settings';
    requestId: string;
    settings: Partial<HostSettings>;
}

/** Check the setup tools; answered with `tools`. */
export interface CheckToolsMessage {
    type: 'check-tools';
    requestId: string;
}

/**
 * The global config copy (Q19): the files to write under `~/.claude`, and the
 * paths a previous copy wrote that are gone on the Mac now. One way only; the
 * agent never sends config back. Answered with `done`.
 */
export interface CopyConfigMessage {
    type: 'copy-config';
    requestId: string;
    files: ConfigFile[];
    removed: string[];
}

export type MacMessage =
    | HelloMessage
    | OpenSessionMessage
    | AttachMessage
    | InputMessage
    | ResizeMessage
    | SignalMessage
    | ListSessionsMessage
    | AskReplyMessage
    | ArchiveReplyMessage
    | GetHostSettingsMessage
    | SetHostSettingsMessage
    | CheckToolsMessage
    | CopyConfigMessage
    | ByeMessage;

// ── Agent → Mac ──

export interface WelcomeMessage {
    type: 'welcome';
    protocol: number;
    agentVersion: string;
    settings: HostSettings;
}

export interface OpenedMessage {
    type: 'opened';
    requestId: string;
    ok: boolean;
    error?: string;
    /** True when the session was already alive and this was an attach. */
    reattached?: boolean;
}

export interface AttachedMessage {
    type: 'attached';
    sessionId: string;
    /** False when the agent has no such session, or its process has ended. */
    alive: boolean;
    /** Clear the terminal first: the replay does not continue from `since`. */
    reset: boolean;
}

export interface ExitedMessage {
    type: 'exited';
    sessionId: string;
    exitCode: number;
    signal?: number;
}

export interface SessionsMessage {
    type: 'sessions';
    requestId: string;
    sessions: AgentSessionInfo[];
}

/**
 * A session's CLI called AskUserQuestion, through the agent's hook.
 *
 * The CLI is held until the Mac sends `ask-reply` with the same `hookId`. The
 * agent replies with no decision itself (the CLI then asks in its terminal)
 * when the link goes away first.
 */
export interface AskMessage {
    type: 'ask';
    hookId: string;
    /** The id the session was launched under, which the Mac's QuestionService finds it by. */
    launchId: string;
    asked: AskedQuestions;
}

/** The CLI's hook request went away before an answer: withdraw it on the Mac. */
export interface AskWithdrawnMessage {
    type: 'ask-withdrawn';
    hookId: string;
}

/** A turn ended on a grilling round (the Stop hook's last message). */
export interface GrillRoundMessage {
    type: 'grill-round';
    launchId: string;
    questions: Question[];
}

/** The user submitted a prompt in the session (the UserPromptSubmit hook). */
export interface PromptSubmittedMessage {
    type: 'prompt-submitted';
    launchId: string;
}

/** The session called the archive tool; the Mac answers `archive-reply`. */
export interface ArchiveRequestMessage {
    type: 'archive-request';
    hookId: string;
    launchId: string;
}

/** A turn of the session ended (the Stop hook), for the archive tool. */
export interface TurnEndedMessage {
    type: 'turn-ended';
    launchId: string;
}

export interface HostSettingsMessage {
    type: 'host-settings';
    requestId: string;
    settings: HostSettings;
}

export interface ToolsMessage {
    type: 'tools';
    requestId: string;
    tools: ToolCheck[];
    /** Whether `sudo -n true` works, or sudo asks for a password (true) or is missing (false). */
    sudo: boolean;
}

/** The generic answer to a request that has nothing to return. */
export interface DoneMessage {
    type: 'done';
    requestId: string;
    ok: boolean;
    error?: string;
}

export type AgentMessage =
    | WelcomeMessage
    | OpenedMessage
    | AttachedMessage
    | ExitedMessage
    | SessionsMessage
    | AskMessage
    | AskWithdrawnMessage
    | GrillRoundMessage
    | PromptSubmittedMessage
    | ArchiveRequestMessage
    | TurnEndedMessage
    | HostSettingsMessage
    | ToolsMessage
    | DoneMessage
    | ByeMessage;

// ── Either way ──

/** Sent just before a side closes the link on purpose. */
export interface ByeMessage {
    type: 'bye';
    code: AgentCloseCode;
    reason?: string;
}

/**
 * One chunk of a session's terminal output, agent → Mac only.
 *
 * `seq` counts the session's chunks from 0 and never repeats, which is what
 * lets an `attach` after a dropped link ask for exactly what it missed.
 */
export interface TerminalOutput {
    sessionId: string;
    seq: number;
    data: string;
}
