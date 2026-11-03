/**
 * The agent's tools part (#276 stage 4, #296): what the Mac's git and
 * transcript adapters ask of a VM folder.
 *
 * The project page, the session work page and the Plan tab stay on the Mac,
 * whose `gh` already answers their GitHub half. Only the git state and the
 * transcripts are on the VM, so for a VM project the Mac's adapters send the
 * few things they ask of a folder here:
 *
 * - `run-tool`: `git -C <cwd> …` or `gh` in `cwd`, as argv (never a shell),
 *   answered with its exit code, stdout (binary-safe, base64) and the tail of
 *   stderr.
 * - `read-file` and `stat-files`: a working file's bytes or size, for image
 *   compare and the diff's size checks; regular files only, never through a
 *   symlink.
 * - `watch-dir` and `unwatch-dir`: a debounced `dir-changed` when a working
 *   tree's git state moves (`tools-watches.ts`).
 * - `transcript-query`: the read methods of the VM's own transcript store
 *   (`tools-transcripts.ts`).
 *
 * ## Prompts
 *
 * The agent runs headless: a credential or host-key prompt would sit waiting
 * on a terminal nobody sees until the timeout. Every run gets
 * GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never and GH_PROMPT_DISABLED=1 on top
 * of the login-shell environment, has its stdin closed (after the bytes the
 * Mac sent, if any), and runs in its own process group with no terminal.
 *
 * `git` also gets GIT_OPTIONAL_LOCKS=0, as the Mac's own git does: without it
 * `git status` and `git diff` refresh the index and write it back, a write the
 * page promised not to make, and one the watch would report, prompting
 * another read, round and round.
 *
 * ## How many at once
 *
 * A page opening fires dozens of git reads together. Each client runs at most
 * MAX_RUNS_PER_CLIENT of them at a time and queues the rest, first come first
 * served, so one Mac opening a big page can't fork hundreds of gits on the VM
 * at once, and a second Mac still gets its own share. When a client goes, its
 * queue is dropped and its running tools are killed: their answers have
 * nowhere to go.
 *
 * ## Limits
 *
 * A run's stdout is kept up to TOOL_OUTPUT_CAP_BYTES (the rest is read and
 * dropped, and `truncated` says so), its stderr's last STDERR_TAIL_BYTES, and
 * it is killed (the whole process group, SIGKILL) after its `timeoutMs`,
 * capped at MAX_TOOL_TIMEOUT_MS, answering code -1.
 */
import {TOOL_OUTPUT_CAP_BYTES, TRANSCRIPT_TEXT_CAP_CHARS} from '../../../domain/agent/protocol';
import type {
    AgentToolName,
    ReadFileMessage,
    RunToolMessage,
    StatFilesMessage,
    ToolResultMessage,
    TranscriptQueryMessage,
} from '../../../domain/agent/protocol';
import type {ClientLink} from '../../ports/agent-link';
import type {Timers} from '../../ports/clock';
import type {Logger} from '../../ports/logger';
import type {ToolsMessage, ToolsPart} from './handlers';
import {expandHome} from './session-host';
import {answerTranscriptQuery, type QueryableTranscripts} from './tools-transcripts';
import {Watches, type TreeWatcher} from './tools-watches';

// ── Ports ──

/** What one tool run came to. */
export interface ToolRun {
    /** The exit code; -1 when the tool could not start, was killed on its timeout, or was aborted. */
    code: number;
    /** At most `maxStdoutBytes` of stdout, raw. */
    stdout: Uint8Array;
    /** True when stdout had more than `maxStdoutBytes`; the rest was dropped. */
    truncated: boolean;
    /** The last `maxStderrBytes` of stderr, as text; or why the tool could not start. */
    stderr: string;
}

/** Options for one run. */
export interface ToolRunOptions {
    /** The working folder; the agent's own when omitted. */
    cwd?: string;
    /** Variables on top of the login-shell environment. */
    env: Record<string, string>;
    /** Written to stdin, which is then closed; stdin is closed at once when omitted. */
    stdin?: Uint8Array;
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    /** Aborting kills the tool and answers code -1. */
    signal?: AbortSignal;
}

/**
 * Runs a program as argv, never through a shell, with no terminal. Never
 * rejects: a missing binary, a timeout or an abort is code -1.
 */
export interface ToolRunner {
    run(command: string, args: readonly string[], options: ToolRunOptions): Promise<ToolRun>;
}

/**
 * The working files a page reads, on absolute paths. Both refuse (null) a
 * path that is not a regular file, or that has a symlink anywhere on it.
 */
export interface WorkingFiles {
    /** The file's bytes; null when it is refused, missing or larger than `maxBytes`. */
    read(path: string, maxBytes: number): Promise<Uint8Array | null>;
    /** The file's size in bytes; null when it is refused or missing. */
    size(path: string): Promise<number | null>;
}

// ── Limits ──

/** Each client's tools running at once; the rest wait their turn. */
export const MAX_RUNS_PER_CLIENT = 8;

/** The longest a run may take, whatever the Mac asks: a fetch over a slow link, not a hung prompt. */
export const MAX_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/** How much of stderr is kept: its tail, where git and gh put the reason. */
export const STDERR_TAIL_BYTES = 4096;

/** The most paths one `stat-files` answers for; a page asks for a diff's files, not a tree's. */
export const MAX_STAT_PATHS = 5000;

/** How long a watch's poll may take its `git status`. */
const POLL_TIMEOUT_MS = 30 * 1000;

/** Every run gets these, so nothing waits on a prompt the Mac can't see. */
const NO_PROMPTS: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
};

/** `git` gets these too: no index refresh written back behind the page's reads (see above). */
const GIT_ENV: Record<string, string> = {...NO_PROMPTS, GIT_OPTIONAL_LOCKS: '0'};

export interface ToolsDeps {
    runner: ToolRunner;
    files: WorkingFiles;
    watcher: TreeWatcher;
    transcripts: QueryableTranscripts;
    /** The VM user's home folder, for a `~` path. */
    home: string;
    timers: Timers;
    log: Logger;
    /** Override TOOL_OUTPUT_CAP_BYTES, for tests. */
    outputCapBytes?: number;
    /** Override MAX_RUNS_PER_CLIENT, for tests. */
    maxRunsPerClient?: number;
    /** Override TRANSCRIPT_TEXT_CAP_CHARS, for tests. */
    textCapChars?: number;
    /** Override the watches' debounce, for tests. */
    watchDebounceMs?: number;
    /** Override the watches' poll interval, for tests. */
    watchPollMs?: number;
}

/** One client's runs: how many are going, what waits, and how to kill what's going. */
interface ClientRuns {
    running: number;
    queue: (() => void)[];
    aborts: Set<AbortController>;
}

/**
 * A path the Mac sent, as an absolute VM path: `~` and `~/…` are the VM
 * user's home (VM paths keep their `~`, see `domain/agent/vm-paths`), and
 * anything else must already be absolute. Null for a relative path, which
 * would resolve against wherever the agent happens to run.
 */
export function absoluteVmPath(path: string, home: string): string | null {
    const expanded = expandHome(path, home);
    return expanded.startsWith('/') && !expanded.includes('\0') ? expanded : null;
}

export class Tools implements ToolsPart {
    private readonly runs = new Map<ClientLink, ClientRuns>();
    private readonly watches: Watches;

    constructor(private readonly deps: ToolsDeps) {
        this.watches = new Watches({
            watcher: deps.watcher,
            fingerprint: (dir) => this.fingerprint(dir),
            timers: deps.timers,
            log: deps.log,
            debounceMs: deps.watchDebounceMs,
            pollMs: deps.watchPollMs,
        });
    }

    public clientConnected(_client: ClientLink): void {}

    /** Its queued runs are dropped, its running ones killed, and its watches stopped. */
    public clientGone(client: ClientLink): void {
        const runs = this.runs.get(client);
        if (runs) {
            runs.queue.length = 0;
            for (const abort of runs.aborts) abort.abort();
            this.runs.delete(client);
        }
        this.watches.clientGone(client);
    }

    public handle(client: ClientLink, message: ToolsMessage): void {
        switch (message.type) {
            case 'run-tool':
                return this.enqueue(client, message);
            case 'read-file':
                void this.readFile(client, message);
                return;
            case 'stat-files':
                void this.statFiles(client, message);
                return;
            case 'watch-dir': {
                const dir = absoluteVmPath(message.dir, this.deps.home);
                if (!dir) return this.deps.log.warn(`agent: watch refused, not an absolute path: ${message.dir}`);
                return this.watches.start(client, message.watchId, dir);
            }
            case 'unwatch-dir':
                return this.watches.end(client, message.watchId);
            case 'transcript-query':
                return this.transcriptQuery(client, message);
        }
    }

    /** How many watches are open now, for tests. */
    public get watchCount(): number {
        return this.watches.count;
    }

    // ── run-tool ──

    /** Run now if the client has a free slot, else wait in its queue. */
    private enqueue(client: ClientLink, message: RunToolMessage): void {
        let runs = this.runs.get(client);
        if (!runs) {
            runs = {running: 0, queue: [], aborts: new Set()};
            this.runs.set(client, runs);
        }
        const state = runs;
        const max = this.deps.maxRunsPerClient ?? MAX_RUNS_PER_CLIENT;
        const start = () => {
            state.running++;
            void this.runTool(client, message, state).finally(() => {
                state.running--;
                const next = state.queue.shift();
                if (next) next();
            });
        };
        if (state.running < max) start();
        else state.queue.push(start);
    }

    private async runTool(client: ClientLink, message: RunToolMessage, runs: ClientRuns): Promise<void> {
        const {requestId, tool, args} = message;
        const answer = (result: Omit<ToolResultMessage, 'type' | 'requestId'>) => {
            if (!client.closed) client.send({type: 'tool-result', requestId, ...result});
        };
        const cwd = absoluteVmPath(message.cwd, this.deps.home);
        if (!cwd) {
            return answer({code: -1, stdoutBase64: '', stderr: `refused: cwd must be absolute, got ${message.cwd}`});
        }
        let stdin: Uint8Array | undefined;
        if (message.stdinBase64 !== undefined) stdin = Buffer.from(message.stdinBase64, 'base64');

        const abort = new AbortController();
        runs.aborts.add(abort);
        try {
            const run = await this.deps.runner.run(tool, argv(tool, cwd, args), {
                cwd: tool === 'gh' ? cwd : undefined,
                env: tool === 'git' ? GIT_ENV : NO_PROMPTS,
                stdin,
                timeoutMs: Math.min(Math.max(message.timeoutMs, 1), MAX_TOOL_TIMEOUT_MS),
                maxStdoutBytes: this.deps.outputCapBytes ?? TOOL_OUTPUT_CAP_BYTES,
                maxStderrBytes: STDERR_TAIL_BYTES,
                signal: abort.signal,
            });
            answer({
                code: run.code,
                stdoutBase64: Buffer.from(run.stdout).toString('base64'),
                stderr: run.stderr,
                ...(run.truncated ? {truncated: true} : {}),
            });
        } finally {
            runs.aborts.delete(abort);
        }
    }

    // ── read-file and stat-files ──

    private async readFile(client: ClientLink, message: ReadFileMessage): Promise<void> {
        const {requestId} = message;
        const path = absoluteVmPath(message.path, this.deps.home);
        const maxBytes = Math.min(message.maxBytes, this.deps.outputCapBytes ?? TOOL_OUTPUT_CAP_BYTES);
        const bytes = path && maxBytes >= 0 ? await this.deps.files.read(path, maxBytes) : null;
        if (client.closed) return;
        if (!bytes) return client.send({type: 'file-content', requestId, found: false});
        client.send({
            type: 'file-content',
            requestId,
            found: true,
            contentBase64: Buffer.from(bytes).toString('base64'),
        });
    }

    private async statFiles(client: ClientLink, message: StatFilesMessage): Promise<void> {
        const sizes: Record<string, number> = {};
        // Keyed by the path as sent, so the Mac can look its own names up.
        for (const asked of [...new Set(message.paths)].slice(0, MAX_STAT_PATHS)) {
            const path = absoluteVmPath(asked, this.deps.home);
            const size = path ? await this.deps.files.size(path) : null;
            if (size !== null) sizes[asked] = size;
        }
        if (!client.closed) client.send({type: 'file-stats', requestId: message.requestId, sizes});
    }

    // ── watch-dir: the fingerprint a polled watch compares ──

    /** `git status` with the branch header: moves with HEAD, the branch, the index and the working files. */
    private async fingerprint(dir: string): Promise<string | null> {
        const run = await this.deps.runner.run(
            'git',
            ['-C', dir, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'],
            {env: GIT_ENV, timeoutMs: POLL_TIMEOUT_MS, maxStdoutBytes: TOOL_OUTPUT_CAP_BYTES, maxStderrBytes: 256},
        );
        return run.code === 0 ? Buffer.from(run.stdout).toString('latin1') + (run.truncated ? '…' : '') : null;
    }

    // ── transcript-query ──

    private transcriptQuery(client: ClientLink, message: TranscriptQueryMessage): void {
        if (client.closed) return;
        const answer = answerTranscriptQuery(
            this.deps.transcripts,
            message,
            this.deps.textCapChars ?? TRANSCRIPT_TEXT_CAP_CHARS,
        );
        try {
            client.send(answer);
        } catch (error) {
            // An answer too big for one frame: say so rather than leave the Mac waiting.
            const reason = error instanceof Error ? error.message : String(error);
            client.send({type: 'transcript-answer', requestId: message.requestId, ok: false, error: reason});
        }
    }
}

/** The argv a tool runs with: git always pinned to its folder with `-C`, gh as asked. */
function argv(tool: AgentToolName, cwd: string, args: readonly string[]): string[] {
    return tool === 'git' ? ['-C', cwd, ...args] : [...args];
}
