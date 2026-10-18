/**
 * The Claude CLI as an external system.
 *
 * The usage quotas are read out of it, from the OAuth endpoint using
 * credentials the CLI stores; scheduled tasks and Ask Patch run it.
 */
import type { ClaudeRun } from '../../domain/ask/route';
import type { Usage } from '../../domain/usage/usage';

export interface UsageService {
  /**
   * The current quota windows.
   *
   * Never rejects: a missing token, an offline machine and a rate limit are all
   * reported in the result, because the status bar has to render something.
   */
  fetch(): Promise<Usage>;
}

/** Runs one non-interactive `claude` invocation, for the scheduler. */
export interface CommandRunner {
  run(claudeArgs: readonly string[], cwd: string, name: string, onDone: () => void): void;
}

/**
 * Runs one `claude -p` call and hands back what it printed, for Ask Patch.
 *
 * Unlike a scheduled run, the answer is the point, so stdout is kept. The user
 * is waiting on it and may give up: aborting the signal kills the call, shell
 * and all.
 */
export interface ClaudeCaller {
  /**
   * Resolves when the process ends, however it ends — killed by the signal
   * included. Rejects only when it could not be started.
   */
  call(claudeArgs: readonly string[], signal: AbortSignal): Promise<ClaudeRun>;
}
