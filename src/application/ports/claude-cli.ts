/**
 * The Claude CLI as an external system.
 *
 * The usage quotas are read out of it, from the OAuth endpoint using
 * credentials the CLI stores.
 */
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
