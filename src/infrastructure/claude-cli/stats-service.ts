/**
 * The activity statistics, scraped out of `claude /stats`.
 *
 * There is no API for this. `/stats` writes a cache file as a side effect of
 * rendering its output, so the only way to refresh it is to run a real CLI in a
 * throwaway PTY, wait for it to finish, and then read the file it left behind.
 *
 * Knowing when it has finished is the awkward part: the CLI is a TUI, so it
 * never exits on its own. Two signals are used — a pattern in the visible
 * output, and the busy→idle flip of the spinner in the window title — with a
 * timeout behind both, because a CLI waiting on a prompt we did not anticipate
 * would otherwise hold the PTY forever.
 */
import { stripAnsi } from '../../domain/terminal/ansi';
import { parseTerminalEvents, titleMeansBusy } from '../../domain/terminal/osc';
import { claudeSessionEnv } from '../../domain/launch/terminal-env';
import { shellArgs } from '../../domain/shell/quoting';
import type { StatsService, UsageService } from '../../application/ports/claude-cli';
import type { StatsData } from '../../domain/stats/stats';
import type { FileSystem } from '../../application/ports/file-system';
import type { Logger } from '../../application/ports/logger';
import type { ShellProfileProvider } from '../../application/ports/shell-profiles';
import type { TerminalGateway } from '../../application/ports/terminal-gateway';
import type { Timers } from '../../application/ports/clock';
import type { Usage } from '../../domain/usage/usage';

/** `✳` — the CLI's "waiting for you" glyph, and so its "finished" signal. */
const IDLE_GLYPH = '✳';

/** The PTY the scrape runs in; wide enough that `/stats` does not wrap. */
const SCRAPE_COLS = 120;
const SCRAPE_ROWS = 40;

/** How long `/stats` is given before we take what we have. */
const STATS_TIMEOUT_MS = 10000;

export interface StatsServiceDeps {
  fs: FileSystem;
  terminals: TerminalGateway;
  shells: ShellProfileProvider;
  usage: UsageService;
  timers: Timers;
  log: Logger;
  /** `~/.claude/stats-cache.json`. */
  statsCachePath: string;
  /** Where the throwaway CLI is run from. */
  homeDir: string;
  /** The shell profile the user chose, so the scrape sees their real PATH. */
  shellProfileId(): string;
}

interface RunOptions {
  timeoutMs?: number;
  /** Finish as soon as this matches the visible output. */
  waitFor?: RegExp;
}

export class ClaudeCliStatsService implements StatsService {
  constructor(private readonly deps: StatsServiceDeps) {}

  read(): StatsData | null {
    const { fs, statsCachePath, log } = this.deps;
    if (!fs.exists(statsCachePath)) return null;
    try {
      return JSON.parse(fs.readText(statsCachePath)) as StatsData;
    } catch (err) {
      log.error('[stats] could not read the stats cache:', (err as Error).message);
      return null;
    }
  }

  /**
   * Refresh the cache and fetch the quotas.
   *
   * Both at once, because the stats tab shows them together and the PTY run is
   * the slow half — waiting for it before starting the HTTP request would
   * double the time the tab spends empty.
   */
  async refresh(): Promise<{ stats: StatsData | null; usage: Usage }> {
    const { usage, log } = this.deps;
    try {
      const [, quotas] = await Promise.all([
        this.#run('"/stats"', { waitFor: /streak/i, timeoutMs: STATS_TIMEOUT_MS }),
        usage.fetch().catch(() => ({} as Usage)),
      ]);
      return { stats: this.read(), usage: quotas };
    } catch (err) {
      log.error('[stats] refresh failed:', (err as Error).message);
      return { stats: null, usage: {} };
    }
  }

  /**
   * Run one `claude` command in a PTY and resolve with everything it printed.
   *
   * Resolves exactly once, whichever comes first: the wait pattern matching,
   * the CLI going idle, the process exiting, or the timeout.
   */
  #run(args: string, options: RunOptions = {}): Promise<string> {
    const { terminals, shells, timers, homeDir } = this.deps;
    const profile = shells.resolve(this.deps.shellProfileId());

    return new Promise<string>((resolve) => {
      let output = '';
      let settled = false;
      let trustAccepted = false;
      let sawActivity = false;

      const pty = terminals.spawn({
        file: profile.path,
        args: shellArgs(profile.path, `claude ${args}`, profile.args),
        cwd: homeDir,
        cols: SCRAPE_COLS,
        rows: SCRAPE_ROWS,
        env: claudeSessionEnv(terminals.baseEnv),
      });

      const finish = (): void => {
        if (settled) return;
        settled = true;
        try { pty.kill(); } catch { /* already gone */ }
        resolve(output);
      };

      pty.onData((data: string) => {
        output += data;

        // The CLI asks before running in an untrusted directory. Enter selects
        // "Yes"; without answering, the scrape would time out every time.
        if (!trustAccepted && /trust\s*this\s*folder/i.test(stripAnsi(output))) {
          trustAccepted = true;
          try { pty.write('\r'); } catch { /* already gone */ }
          return;
        }

        if (options.waitFor) {
          if (options.waitFor.test(stripAnsi(output))) finish();
          return;
        }

        // Otherwise wait for the spinner to appear and then stop: the title
        // going from a spinner frame to the idle glyph is the CLI saying it is
        // done. The glyph is looked for anywhere in the chunk, not just in a
        // title, because the CLI also prints it in its prompt.
        if (!sawActivity) {
          for (const event of parseTerminalEvents(data)) {
            if (event.kind === 'title' && titleMeansBusy(event.text)) sawActivity = true;
          }
        } else if (data.includes(IDLE_GLYPH)) {
          finish();
        }
      });

      pty.onExit(() => finish());
      timers.setTimeout(finish, options.timeoutMs ?? STATS_TIMEOUT_MS);
    });
  }
}
