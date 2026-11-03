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
import type {Session} from '../session/session';
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
    /**
     * Stage 5: the copies whose `schedule-*.md` run here rather than on the Mac,
     * as their folders (`~` kept). Stored on the VM, so they keep running while
     * the Mac is away. Absent means none.
     */
    scheduleDirs?: string[];
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

/**
 * Whether `path` may be written inside a project copy by a hand-off: relative,
 * `/`-separated, no `.`/`..`/empty segment, and never inside `.git`.
 */
export function isSafeRepoPath(path: string): boolean {
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
    return segments[0] !== '.git';
}

/** The most of a VM transcript's text that goes to the Mac's search index. */
export const TRANSCRIPT_TEXT_CAP_CHARS = 1_000_000;

/** How long an upload waits for the hand-off that uses it. */
export const UPLOAD_TTL_MS = 10 * 60 * 1000;

/** The most a hand-off's inline files may add up to, raw. */
export const HANDOFF_FILES_CAP_BYTES = 4 * 1024 * 1024;

/** The marker the agent leaves in a copy's `.git`, so it only ever removes copies it made. */
export const COPY_MARKER = 'switchboard-copy';

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

// ── Mac → agent: project copies (stage 2) ──

/**
 * A file too large for one frame (a git bundle) goes up in chunks. `begin`
 * names it and says how big it will be; `chunk`s follow in order; `end` asks
 * the agent to check it and is answered with `done`. An upload not used by a
 * `handoff` within UPLOAD_TTL_MS is thrown away.
 */
export interface UploadBeginMessage {
    type: 'upload-begin';
    uploadId: string;
    size: number;
}

export interface UploadChunkMessage {
    type: 'upload-chunk';
    uploadId: string;
    dataBase64: string;
}

export interface UploadEndMessage {
    type: 'upload-end';
    requestId: string;
    uploadId: string;
    /** Hex SHA-256 of the whole file; a mismatch answers `done ok:false`. */
    sha256: string;
}

/** One ignored config file the user ticked, carried inline (they are small). */
export interface HandoffFile {
    /** Relative to the repository root, `/`-separated; checked with `isSafeRepoPath`. */
    path: string;
    contentBase64: string;
    mode: number;
}

/**
 * Make or update the VM's copy of a project (#276 stage 2).
 *
 * The agent clones `repo` into `<baseFolder>/<repo.name>` with its own
 * credentials (`gh repo clone` for a GitHub repository, else `git clone`), or
 * fetches when that copy exists already. It then fetches the bundle's commits,
 * checks `branch` out at `headOid`, applies the patch of uncommitted changes
 * to the working tree (unstaged), and writes the ticked files. Progress goes
 * out as `handoff-progress`; the answer is `handoff-done`.
 */
export interface HandoffMessage {
    type: 'handoff';
    requestId: string;
    repo: {
        /** The folder name the copy gets, e.g. `switchboard`. */
        name: string;
        /** The Mac's origin URL. */
        origin: string;
        /** `owner/repo` when origin is on GitHub, so the agent can `gh repo clone` it. */
        github?: string;
    };
    branch: string;
    /** The Mac's HEAD, which the copy ends up on. */
    headOid: string;
    /** The commits origin does not have yet, as a git bundle; absent when there are none. */
    bundleUploadId?: string;
    /**
     * Stage 3, a session's hand-off: the name of the worktree the session
     * worked in on the Mac. The copy then gets a worktree of that name on
     * `branch` at `<copy>/.claude/worktrees/<name>`, and everything below
     * (bundle, checkout, patch, files) happens in that worktree. Absent for a
     * hand-off of the project's own checkout.
     */
    worktree?: string;
    /** The uncommitted changes as `git diff --binary`; absent when the tree is clean. */
    patchUploadId?: string;
    files: HandoffFile[];
}

/** Where a copy stands, for Bring back and for removing it; answered with `copy-state`. */
export interface CopyStatusMessage {
    type: 'copy-status';
    requestId: string;
    /** The copy's folder as its project path names it (may start with `~`). */
    dir: string;
}

/** Push a copy's branch to origin, so the Mac can fetch it; answered with `done`. */
export interface PushBranchMessage {
    type: 'push-branch';
    requestId: string;
    dir: string;
    branch: string;
}

/**
 * Delete a copy's folder; answered with `done`. The agent refuses anything
 * that is not a copy it made (the marker in `.git`) under the base folder.
 */
export interface RemoveCopyMessage {
    type: 'remove-copy';
    requestId: string;
    dir: string;
}

// ── Mac → agent: transcripts and session hand-off (stage 3) ──

/**
 * One session's transcript, parsed on the VM; answered with `transcript`. The
 * agent watches that file from now on and sends `transcripts-changed` when it
 * grows, so the Mac asks again only when something happened.
 */
export interface GetTranscriptMessage {
    type: 'get-transcript';
    requestId: string;
    sessionId: string;
}

/** The last `bytes` of a session's transcript, as lines; answered with `transcript-tail`. */
export interface TranscriptTailMessage {
    type: 'transcript-tail';
    requestId: string;
    sessionId: string;
    bytes: number;
}

/**
 * Put a session's transcript (uploaded first) where `claude --resume` on the
 * VM finds it: `~/.claude/projects/<encoded dir>/<sessionId>.jsonl`, `dir`
 * expanded. Refused when a transcript of that id is already there. Answered
 * with `done`.
 */
export interface ImportTranscriptMessage {
    type: 'import-transcript';
    requestId: string;
    sessionId: string;
    /** The folder the session resumes in, as a project path names it (may start with `~`). */
    dir: string;
    uploadId: string;
}

// ── Mac → agent: the project page, session work and Plan tab (stage 4) ──
//
// These pages stay on the Mac: their GitHub half already runs there (the
// Mac's own `gh`), and only their git state and transcripts are on the VM. So
// the agent answers the few things the Mac's git and transcript adapters ask
// of a folder, and those adapters route a VM path (`ssh://user@host//abs`,
// see `domain/agent/vm-paths`) here instead of to the Mac's disk.

/** The tools a `run-tool` may run, always as argv (never a shell), with prompts disabled. */
export type AgentToolName = 'git' | 'gh';

/** Run `git` or `gh` in a folder; answered with `tool-result`. */
export interface RunToolMessage {
    type: 'run-tool';
    requestId: string;
    tool: AgentToolName;
    /** Absolute on the VM. `git` runs as `git -C <cwd> …args`, `gh` with that cwd. */
    cwd: string;
    args: string[];
    /** Bytes for stdin, base64. */
    stdinBase64?: string;
    timeoutMs: number;
}

/** Read a file the working tree holds (image compare's "after"); answered with `file-content`. */
export interface ReadFileMessage {
    type: 'read-file';
    requestId: string;
    /** Absolute on the VM. */
    path: string;
    maxBytes: number;
}

/** The sizes of regular files (never through a symlink); answered with `file-stats`. */
export interface StatFilesMessage {
    type: 'stat-files';
    requestId: string;
    /** Absolute on the VM. */
    paths: string[];
}

/**
 * Watch a working tree for changes, as the Mac's GitWorkspace.watch does for a
 * local one; the agent pushes `dir-changed` (debounced) until `unwatch-dir`
 * or the link closes.
 */
export interface WatchDirMessage {
    type: 'watch-dir';
    watchId: string;
    /** Absolute on the VM. */
    dir: string;
}

export interface UnwatchDirMessage {
    type: 'unwatch-dir';
    watchId: string;
}

/**
 * Ask the VM's own transcript store (the same FileTranscriptStore the Mac
 * uses, over the VM's `~/.claude/projects`). Only the read methods named in
 * TRANSCRIPT_QUERY_METHODS; answered with `transcript-answer`, whose result is
 * that method's return value as JSON.
 */
export interface TranscriptQueryMessage {
    type: 'transcript-query';
    requestId: string;
    method: TranscriptQueryMethod;
    args: unknown[];
}

/** The TranscriptStore read methods a `transcript-query` may call. */
export const TRANSCRIPT_QUERY_METHODS = [
    'locations',
    'readSession',
    'issueMentions',
    'resolveProjectPath',
    'readHeadLines',
    'readTail',
    'sessionMtimeMs',
] as const;

export type TranscriptQueryMethod = (typeof TRANSCRIPT_QUERY_METHODS)[number];

/** The most a `tool-result`'s stdout or a `file-content` may carry, raw. */
export const TOOL_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;

// ── Mac → agent: schedules, uploads to paste (stage 5) ──

/**
 * The sessions whose transcripts sit in these folders on the VM, newest first;
 * answered with `transcript-list`. How the Mac learns of runs it did not start,
 * such as a schedule's on the VM.
 */
export interface ListTranscriptsMessage {
    type: 'list-transcripts';
    requestId: string;
    /** As project paths name them (`~` kept); a session counts when it ran in one, or below one. */
    dirs: string[];
    /** Only sessions modified since then, epoch ms; absent for all. */
    since?: number;
}

/**
 * Put a finished upload where a session on the VM can read it, a file dropped
 * on its terminal: `~/.switchboard/drops/<random>/<name>`. Answered with `placed`.
 */
export interface PlaceUploadMessage {
    type: 'place-upload';
    requestId: string;
    uploadId: string;
    /** The file's own name, one safe segment. */
    name: string;
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
    | UploadBeginMessage
    | UploadChunkMessage
    | UploadEndMessage
    | HandoffMessage
    | CopyStatusMessage
    | PushBranchMessage
    | RemoveCopyMessage
    | GetTranscriptMessage
    | TranscriptTailMessage
    | ImportTranscriptMessage
    | RunToolMessage
    | ReadFileMessage
    | StatFilesMessage
    | WatchDirMessage
    | UnwatchDirMessage
    | TranscriptQueryMessage
    | ListTranscriptsMessage
    | PlaceUploadMessage
    | ByeMessage;

// ── Agent → Mac ──

export interface WelcomeMessage {
    type: 'welcome';
    protocol: number;
    agentVersion: string;
    settings: HostSettings;
    /**
     * The agent user's home folder on the VM (stage 4). A project's own path may
     * be `~/…`, and `run-tool`, `read-file`, `stat-files` and `watch-dir` take
     * absolute paths, so the Mac expands a leading `~` with this. Absent from
     * an agent older than stage 4.
     */
    home?: string;
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

// ── Agent → Mac: project copies (stage 2) ──

/** One line of a running hand-off, for the progress list. */
export interface HandoffProgressMessage {
    type: 'handoff-progress';
    requestId: string;
    line: string;
}

export interface HandoffDoneMessage {
    type: 'handoff-done';
    requestId: string;
    ok: boolean;
    /** Which step failed, as the progress named it. */
    error?: string;
    /** The copy's folder in the form a project path takes: `<baseFolder>/<name>`, `~` kept. */
    dir?: string;
    /** True when an existing copy was updated rather than cloned. */
    reused?: boolean;
}

/** A commit on the copy that origin does not have. */
export interface CopyCommit {
    oid: string;
    subject: string;
}

export interface CopyStateMessage {
    type: 'copy-state';
    requestId: string;
    ok: boolean;
    error?: string;
    /** The branch checked out; null on a detached HEAD. */
    branch?: string | null;
    headOid?: string;
    /** The branch's upstream (`origin/x`), or null when it has none yet. */
    upstream?: string | null;
    /** Commits not on the upstream (or, without one, not on any origin branch), newest first. */
    unpushed?: CopyCommit[];
    /** Paths with uncommitted changes, including untracked files that are not ignored. */
    uncommitted?: string[];
}

// ── Agent → Mac: transcripts (stage 3) ──

/** A session's transcript as the Mac lists and searches it. */
export interface AgentTranscript {
    /** The folder the session ran in, absolute on the VM. */
    cwd: string;
    /** The transcript file's mtime, epoch ms. */
    mtimeMs: number;
    /** `parseTranscript`'s answer; `textContent` capped at TRANSCRIPT_TEXT_CAP_CHARS. */
    session: Session;
}

export interface TranscriptMessage {
    type: 'transcript';
    requestId: string;
    /** Null when the VM has no transcript of that id (yet), or none worth listing. */
    transcript: AgentTranscript | null;
}

export interface TranscriptTailReply {
    type: 'transcript-tail';
    requestId: string;
    lines: string[];
}

/** Transcripts the Mac asked for before have changed on disk; it asks again. */
export interface TranscriptsChangedMessage {
    type: 'transcripts-changed';
    sessionIds: string[];
}

// ── Agent → Mac: answers for the pages (stage 4) ──

export interface ToolResultMessage {
    type: 'tool-result';
    requestId: string;
    /** The exit code; -1 when the tool could not start or timed out. */
    code: number;
    stdoutBase64: string;
    /** The last part of stderr, for error messages. */
    stderr: string;
    /** True when stdout passed TOOL_OUTPUT_CAP_BYTES and was cut. */
    truncated?: boolean;
}

export interface FileContentMessage {
    type: 'file-content';
    requestId: string;
    found: boolean;
    contentBase64?: string;
}

export interface FileStatsMessage {
    type: 'file-stats';
    requestId: string;
    /** Path → size in bytes, for the paths that are regular files. */
    sizes: Record<string, number>;
}

export interface DirChangedMessage {
    type: 'dir-changed';
    watchId: string;
}

export interface TranscriptAnswerMessage {
    type: 'transcript-answer';
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}

// ── Agent → Mac (stage 5) ──

export interface TranscriptListMessage {
    type: 'transcript-list';
    requestId: string;
    sessions: {sessionId: string; dir: string; mtimeMs: number}[];
}

export interface PlacedMessage {
    type: 'placed';
    requestId: string;
    ok: boolean;
    /** Absolute on the VM. */
    path?: string;
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
    | HandoffProgressMessage
    | HandoffDoneMessage
    | CopyStateMessage
    | TranscriptMessage
    | TranscriptTailReply
    | TranscriptsChangedMessage
    | ToolResultMessage
    | FileContentMessage
    | FileStatsMessage
    | DirChangedMessage
    | TranscriptAnswerMessage
    | TranscriptListMessage
    | PlacedMessage
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
