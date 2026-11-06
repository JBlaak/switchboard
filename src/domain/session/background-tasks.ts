/**
 * The background tasks a session's turn ended with still running, read off
 * its transcript, and which of them are watches.
 *
 * A turn can end while work it started goes on: a shell run in the
 * background, or a background agent. Each wakes Claude again when it
 * finishes. Most of the time that is a **watch**: a shell that only waits on
 * GitHub (`gh pr checks --watch`, `gh run watch`, a `gh` poll loop with
 * `sleep`). A turn that pushed, reported and then watches CI has handed back
 * to the user, who reads the report while GitHub works. Anything else, a
 * build, a test run, an agent or a shell that can't be told, is **work**: the
 * session is still making something, so it is still working.
 *
 * The transcript says it all. A background `Bash` call's result carries a
 * `backgroundTaskId` and its call the command; a background agent's result is
 * `async_launched` with an `agentId`; a finished task is reported in a
 * `<task-notification>` naming its id, written as a queued prompt, a
 * `queue-operation` or a plain prompt; a task Claude stopped is a `TaskStop`
 * (or the older `KillShell`) call naming it.
 */
import {parseTranscriptLine} from './transcript';

/** One background task still running. */
export interface BackgroundTask {
    /** The CLI's id for it: a shell's `backgroundTaskId` or an agent's `agentId`. */
    id: string;
    /** What it is, as Claude described it. */
    description: string;
    /** Only waits on GitHub. */
    watch: boolean;
}

/** What a turn's background tasks keep going: none, only watches, or work. */
export type TurnHolds = 'none' | 'watches' | 'work';

export function turnHolds(tasks: readonly BackgroundTask[]): TurnHolds {
    if (tasks.length === 0) return 'none';
    return tasks.every((task) => task.watch) ? 'watches' : 'work';
}

/**
 * The programs a watch may run beside `gh`: waiting, and reading what `gh`
 * printed.
 */
const WATCH_STEPS: ReadonlySet<string> = new Set([
    'gh',
    'sleep',
    'grep',
    'jq',
    'echo',
    'printf',
    'true',
    'false',
    'break',
    'continue',
    'exit',
    'test',
    '[',
    '[[',
    'date',
]);

/** Shell words that open or close a loop or condition, before a step's program. */
const KEYWORDS: ReadonlySet<string> = new Set([
    'do',
    'done',
    'then',
    'else',
    'fi',
    'until',
    'while',
    'if',
    '!',
    '{',
    '}',
]);

/** The program a step runs, past keywords and variable assignments; undefined when it runs none. */
function programOf(step: string): string | undefined {
    return step
        .trim()
        .split(/\s+/)
        .find((word) => word !== '' && !KEYWORDS.has(word) && !/^\w+=/.test(word));
}

/**
 * Whether a background shell's command is a watch: every step of it is `gh`,
 * a wait or plumbing, and it waits on GitHub (`--watch`, `gh run watch`, or
 * `gh` polled with `sleep`). A shell without a command is work.
 */
export function isWatch(command: string | undefined): boolean {
    if (command === undefined) return false;
    const programs = command
        .split(/&&|\|\||\$\(|[;|\n`()]/)
        .map(programOf)
        .filter((program): program is string => program !== undefined);
    if (!programs.every((program) => WATCH_STEPS.has(program))) return false;
    if (!programs.includes('gh')) return false;
    return /\s--watch\b|\bgh\s+run\s+watch\b/.test(command) || programs.includes('sleep');
}

// The lines are read loosely, as the CLI writes them: each field
// checked before it is trusted.

type Line = Record<string, unknown>;

function isRecord(value: unknown): value is Line {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The content blocks of a line's message of one type. */
function blocks(line: Line, type: string): Line[] {
    const message = line.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return [];
    return message.content.filter((block): block is Line => isRecord(block) && block.type === type);
}

/** The text a line may carry a background task's report in. */
function reportText(line: Line): string | undefined {
    if (line.type === 'queue-operation' && line.operation === 'enqueue') {
        return typeof line.content === 'string' ? line.content : undefined;
    }
    if (line.type === 'attachment' && isRecord(line.attachment) && line.attachment.type === 'queued_command') {
        return typeof line.attachment.prompt === 'string' ? line.attachment.prompt : undefined;
    }
    if (line.type === 'user' && isRecord(line.message)) {
        const content = line.message.content;
        if (typeof content === 'string') return content;
        const text = blocks(line, 'text')[0]?.text;
        return typeof text === 'string' ? text : undefined;
    }
    return undefined;
}

/** The task a `<task-notification>` reports on, by its id. */
function reportedTask(text: string | undefined): string | undefined {
    if (text === undefined || !/^\s*<task-notification[\s>]/.test(text)) return undefined;
    return /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim();
}

/** The task a `TaskStop` or `KillShell` call stops, by its id. */
function stoppedTask(use: Line): string | undefined {
    if (!isRecord(use.input)) return undefined;
    if (use.name === 'TaskStop' && typeof use.input.task_id === 'string') return use.input.task_id;
    if (use.name === 'KillShell' && typeof use.input.shell_id === 'string') return use.input.shell_id;
    return undefined;
}

/**
 * The background tasks launched and not reported done or stopped, oldest
 * first, from a transcript's lines in file order (its tail will do: a line
 * cut in half fails to parse and is skipped).
 *
 * `since` is when the process started, in epoch ms: a task launched before
 * it belonged to an earlier process and cannot be running now.
 */
export function runningBackgroundTasks(lines: readonly string[], since: number): BackgroundTask[] {
    const descriptions = new Map<unknown, string>();
    const commands = new Map<unknown, string>();
    const running = new Map<string, BackgroundTask>();
    for (const raw of lines) {
        const line = parseTranscriptLine(raw) as Line | null;
        if (!isRecord(line) || line.isSidechain === true) continue;

        for (const use of blocks(line, 'tool_use')) {
            if (isRecord(use.input) && typeof use.input.description === 'string') {
                descriptions.set(use.id, use.input.description);
            }
            if (isRecord(use.input) && typeof use.input.command === 'string') commands.set(use.id, use.input.command);
            const stopped = stoppedTask(use);
            if (stopped !== undefined) running.delete(stopped);
        }

        const result = line.toolUseResult;
        if (line.type === 'user' && isRecord(result)) {
            const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
            const current = !(at < since);
            const call = blocks(line, 'tool_result')[0]?.tool_use_id;
            if (typeof result.backgroundTaskId === 'string') {
                if (current) {
                    running.set(result.backgroundTaskId, {
                        id: result.backgroundTaskId,
                        description: descriptions.get(call) ?? 'a background shell',
                        watch: isWatch(commands.get(call)),
                    });
                }
                continue;
            }
            if (result.status === 'async_launched' && typeof result.agentId === 'string') {
                if (current) {
                    running.set(result.agentId, {
                        id: result.agentId,
                        description: typeof result.description === 'string' ? result.description : 'a background agent',
                        watch: false,
                    });
                }
                continue;
            }
        }

        const reported = reportedTask(reportText(line));
        if (reported !== undefined) running.delete(reported);
    }
    return [...running.values()];
}
