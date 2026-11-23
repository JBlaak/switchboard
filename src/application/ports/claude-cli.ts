/**
 * The Claude CLI as an external system.
 *
 * The usage quotas are read out of it, from the OAuth endpoint using
 * credentials the CLI stores; scheduled tasks and Ask Patch run it.
 */
import type {ClaudeRun} from '../../domain/ask/route';
import type {Usage} from '../../domain/usage/usage';

export interface UsageService {
    /**
     * The current quota windows.
     *
     * Never rejects: a missing token, an offline machine and a rate limit are all
     * reported in the result, because the status bar has to render something.
     */
    fetch(): Promise<Usage>;
}

/** How one scheduled `claude` process ended. */
export interface CommandEnding {
    /** Null when a signal ended it, or it never started. */
    exitCode: number | null;
    signal: string | null;
    /** What it printed: the `--output-format json` result, after anything the shell printed first. */
    stdout: string;
    /** The end of what it printed to stderr, where a failing run says why. */
    stderr: string;
    /** It could not be started at all, and why; null when it ran. */
    startError: string | null;
}

/** A scheduled run going now. */
export interface RunningCommand {
    /** Signal the run; its time limit sends SIGTERM, then SIGKILL when that is ignored. */
    kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/**
 * Runs one non-interactive `claude` invocation, for the scheduler. `onDone`
 * is called exactly once, however the run ends, also when it never started.
 */
export interface CommandRunner {
    run(
        claudeArgs: readonly string[],
        cwd: string,
        name: string,
        onDone: (ending: CommandEnding) => void,
    ): RunningCommand;
}

/** How long a warm process may wait for its request before it is killed (S2). */
export const WARM_IDLE_MS = 5 * 60_000;

/**
 * A `claude` process started ahead of the request, booted and waiting for its
 * prompt (S2). It serves one `send`; what it costs until then is a process,
 * not a model request.
 */
export interface WarmCall {
    /**
     * Hand over the prompt and resolve with the answer. The run reads like one
     * from `call`: `stdout` holds the same result envelope `--output-format
     * json` prints. Aborting kills the process, as it does a `call`. A process
     * that died or was killed for idling in the meantime is started again, so a
     * send always gets an answer, only a slower one.
     */
    send(prompt: string, signal: AbortSignal): Promise<ClaudeRun>;
}

/**
 * Runs one `claude -p` call and hands back what it printed, for Ask Patch.
 *
 * Unlike a scheduled run, the answer is the point, so stdout is kept. The user
 * is waiting on it and may give up: aborting the signal kills the call and
 * everything it started.
 */
export interface ClaudeCaller {
    /**
     * Resolves when the process ends, however it ends — killed by the signal
     * included. Rejects only when it could not be started.
     */
    call(claudeArgs: readonly string[], signal: AbortSignal): Promise<ClaudeRun>;
    /**
     * Start `claude <bootArgs>` now, to be sent its prompt later. Killed after
     * `WARM_IDLE_MS` unused, and when the app quits.
     */
    warm(bootArgs: readonly string[]): WarmCall;
}
