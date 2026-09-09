/**
 * The Claude CLI as an external system.
 *
 * Two things are read out of it that no API offers: the usage quotas, which
 * come from the OAuth endpoint using credentials the CLI stores, and the
 * activity statistics, which only exist as the output of `/stats` and have to
 * be scraped by running the CLI in a throwaway PTY.
 */
import type { Usage } from '../../domain/usage/usage';
import type { StatsData } from '../../domain/stats/stats';

export interface UsageService {
  /**
   * The current quota windows.
   *
   * Never rejects: a missing token, an offline machine and a rate limit are all
   * reported in the result, because the status bar has to render something.
   */
  fetch(): Promise<Usage>;
}

export interface StatsService {
  /** The cached statistics, or null before the CLI has ever written them. */
  read(): StatsData | null;

  /**
   * Run `/stats` to refresh that cache, and fetch the quotas alongside it.
   *
   * Slow — it starts a real CLI in a PTY and waits for it to finish — so it is
   * only ever triggered by the user opening the stats tab.
   */
  refresh(): Promise<{ stats: StatsData | null; usage: Usage }>;
}

/** Runs one non-interactive `claude` invocation, for the scheduler. */
export interface CommandRunner {
  run(claudeArgs: readonly string[], cwd: string, name: string, onDone: () => void): void;
}
