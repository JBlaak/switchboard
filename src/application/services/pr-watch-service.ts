/**
 * The CI watch: every open PR of every running session, kept an eye on while
 * Switchboard runs, whether or not a Session work page is open (W1).
 *
 * Once a minute, and once more when the window gets focus, it asks `gh` about
 * them — one batched request per repository, however many sessions share it —
 * and does three things with the answer:
 *
 * - **Auto-fix (W2, W3).** A failing check is handed to the session that
 *   opened the PR as a Fix CI, with the check's name, its head commit and the
 *   end of its log, at most twice per check; then the PR is given up on: it
 *   needs you, and the session's row says so. The history is stored, so a
 *   restart does not hand out two fresh attempts.
 * - **Sidebar dots (W4).** Each PR's colour, pushed for the session's row only
 *   when it changed.
 * - **Stopping.** A merged or closed PR has nothing left to watch.
 *
 * Nothing here is ever typed into a session that is not running: only running
 * sessions are watched, and a Fix CI that is queued waits in the session's
 * queue (the action service's) until it is running and idle.
 */
import { autoFixAttempts, autoFixDecision, hasAutoFixStreak, type AutoFixEvent } from '../../domain/session-work/auto-fix';
import { isWorking, needsYou, statusDot, type PullRequestDot } from '../../domain/session-work/status';
import type { SessionPullRequest } from '../../domain/session/session';
import type { PullRequestStatus, SessionWorkItem, WorkLocation } from '../../domain/session-work/model';
import type { AutoFixHistory, AutoFixRecord } from '../ports/auto-fix-history';
import type { Clock, TimerHandle, Timers } from '../ports/clock';
import type { GitWorkspace } from '../ports/git-workspace';
import type { GitHubCli } from '../ports/github-cli';
import type { Logger } from '../ports/logger';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { TranscriptStore } from '../ports/transcript-store';
import type { SessionActionService } from './session-action-service';

/** How often `gh` is asked about the running sessions' PRs (W1). */
export const PR_WATCH_INTERVAL_MS = 60_000;

/** How much of a failing check's log the page's Checks panel shows. */
export const CHECK_LOG_LINES = 80;

/** A running session, as the watch needs it. */
export interface WatchedSession {
  /** The id it goes by now. */
  sessionId: string;
  /** The directory it was started in. */
  projectPath: string;
  /** Its transcript folder, for where it worked; null when it has none yet. */
  folder: string | null;
  /** The PRs its transcript linked, chronological. */
  pullRequests: readonly SessionPullRequest[];
}

export interface PrWatchServiceDeps {
  /** The running Claude sessions (not plain terminals, not remote ones). */
  sessions(): WatchedSession[];
  github: Pick<GitHubCli, 'available' | 'pullRequests' | 'checkLogTail'>;
  history: AutoFixHistory;
  actions: Pick<SessionActionService, 'request' | 'isInFlight' | 'giveUp' | 'settleGaveUp' | 'forSession' | 'follow'>;
  transcripts: Pick<TranscriptStore, 'locations'>;
  git: Pick<GitWorkspace, 'worktreeRoot'>;
  renderer: Pick<RendererGateway, 'prStatusChanged' | 'sessionNeedsAttention'>;
  clock: Clock;
  timers: Timers;
  log: Logger;
}

/** One PR link, with the repository it is in worked out. */
interface WatchedPr {
  link: SessionPullRequest;
  repository: string;
  /** The page's item id for it (`workItemKey`). */
  key: string;
}

export class PrWatchService {
  #interval: TimerHandle | null = null;
  #polling: Promise<void> | null = null;
  /** The last answer `gh` gave about each PR, by URL. */
  readonly #latest = new Map<string, PullRequestStatus>();
  /** Merged and closed PRs, by URL: never asked about again. */
  readonly #finished = new Set<string>();
  /** The sessions watched as of the last poll. */
  #sessions: WatchedSession[] = [];
  /** What was last pushed for each session's row. */
  readonly #published = new Map<string, string>();
  /** Check logs already read, by check run URL: a finished run's log does not change. */
  readonly #logs = new Map<string, string | null>();
  /** Each session's PRs (by item key) with an action queued or with Claude, as last published. */
  readonly #working = new Map<string, Set<string>>();
  /**
   * PRs whose action finished after `gh` last answered, by URL, with the poll
   * count at the time: what `gh` said is from before Claude's push, so the dot
   * stays amber until a poll started after that answers.
   */
  readonly #settling = new Map<string, number>();
  /** Polls started so far. */
  #polls = 0;
  /** A poll asked for while one was running: which repositories (null: all), to run after it. */
  #next: Set<string> | null | undefined = undefined;

  constructor(private readonly deps: PrWatchServiceDeps) {
    // An action changing phase changes a dot (amber while Claude works on it).
    deps.actions.follow(() => this.#publishAll());
  }

  /** Poll now and every minute after. */
  start(): void {
    if (this.#interval) return;
    this.#interval = this.deps.timers.setInterval(() => void this.poll(), PR_WATCH_INTERVAL_MS);
    void this.poll();
  }

  stop(): void {
    this.deps.timers.clearInterval(this.#interval);
    this.#interval = null;
  }

  /** The window got focus: poll once more, when the watch is on (W1). */
  focused(): void {
    if (this.#interval) void this.poll();
  }

  /**
   * Ask `gh` about every open PR of every running session, and act on it. A
   * poll asked for while one is running (a focus during the minute's) is that one.
   */
  poll(): Promise<void> {
    return this.#run(null);
  }

  /**
   * Poll these repositories (null: all). While a poll is running, a targeted
   * one is run after it — the running one may have asked before Claude pushed.
   */
  #run(repositories: Set<string> | null): Promise<void> {
    if (this.#polling) {
      if (repositories) {
        if (this.#next !== null) this.#next = new Set([...(this.#next ?? []), ...repositories]);
      }
      return this.#polling;
    }
    this.#polling = this.#poll(repositories)
      .catch((err) => this.deps.log.error('[pr-watch] polling failed:', (err as Error).message))
      .finally(() => {
        this.#polling = null;
        const next = this.#next;
        this.#next = undefined;
        if (next !== undefined) void this.#run(next);
      });
    return this.#polling;
  }

  /** A PR's state as `gh` last answered it, by URL; null when it never did. */
  stateOf(url: string): PullRequestStatus['state'] | null {
    return this.#latest.get(url)?.state ?? null;
  }

  /** The end of a check run's log, for the page's Checks panel. */
  async checkLog(repository: string, checkRunUrl: string): Promise<string | null> {
    if (this.#logs.has(checkRunUrl)) return this.#logs.get(checkRunUrl) ?? null;
    const log = await this.deps.github.checkLogTail(repository, checkRunUrl, CHECK_LOG_LINES);
    if (log !== null) this.#logs.set(checkRunUrl, log);
    return log;
  }

  async #poll(repositories: Set<string> | null): Promise<void> {
    const ticket = ++this.#polls;
    const sessions = this.deps.sessions();
    this.#forgetStopped(sessions);
    this.#sessions = sessions;

    // Each open PR once, under the first session that linked it.
    const owners = new Map<string, { session: WatchedSession; pr: WatchedPr }>();
    for (const session of sessions) {
      for (const pr of watchedPrs(session)) {
        if (repositories && !repositories.has(pr.repository)) continue;
        if (!this.#finished.has(pr.link.url) && !owners.has(pr.link.url)) owners.set(pr.link.url, { session, pr });
      }
    }
    if (owners.size === 0 || (await this.deps.github.available()) !== 'ok') {
      this.#publishAll();
      return;
    }

    // Whether each attempt is still with Claude is taken before `gh` is asked:
    // an answer that left before Claude pushed must not spend the attempt.
    const histories = new Map<string, AutoFixEvent[]>();
    for (const { pr } of owners.values()) histories.set(pr.link.url, this.#history(pr));

    const byRepository = new Map<string, number[]>();
    for (const { pr } of owners.values()) {
      const numbers = byRepository.get(pr.repository) ?? [];
      numbers.push(pr.link.number);
      byRepository.set(pr.repository, numbers);
    }
    for (const [repository, numbers] of byRepository) {
      const answer = await this.deps.github.pullRequests(repository, numbers);
      for (const status of answer ?? []) {
        const owner = [...owners.values()].find(({ pr }) => pr.repository === repository && pr.link.number === status.number);
        if (!owner) continue;
        this.#latest.set(owner.pr.link.url, { ...status, url: owner.pr.link.url, repository: status.repository || repository });
        // Asked after the action finished: this answer knows what Claude pushed.
        if ((this.#settling.get(owner.pr.link.url) ?? Infinity) < ticket) this.#settling.delete(owner.pr.link.url);
      }
    }

    for (const { session, pr } of owners.values()) {
      const status = this.#latest.get(pr.link.url);
      if (!status) continue;
      try {
        await this.#act(session, pr, status, histories.get(pr.link.url) ?? []);
      } catch (err) {
        this.deps.log.error(`[pr-watch] acting on ${pr.link.url} failed:`, (err as Error).message);
      }
    }
    this.#publishAll();
  }

  /** Auto-fix for one PR, after a fresh answer from `gh`. */
  async #act(session: WatchedSession, pr: WatchedPr, status: PullRequestStatus, history: AutoFixEvent[]): Promise<void> {
    const { actions } = this.deps;
    if (status.state === 'merged' || status.state === 'closed') {
      this.#finished.add(pr.link.url);
      actions.settleGaveUp(session.sessionId, pr.key);
      return;
    }

    // A check that went green wipes its slate, and ends a give-up on it.
    for (const check of status.checks ?? []) {
      if (check.state !== 'passing' || !hasAutoFixStreak(status, check.name, history)) continue;
      this.#record(history, { kind: 'passed', repository: status.repository, number: status.number, checkName: check.name });
      actions.settleGaveUp(session.sessionId, pr.key, check.name);
    }

    // Something you asked for is waiting or with Claude — a Fix CI of your own,
    // or a Ship it, which fixes CI itself. Auto-fix stays out of its way, and
    // does not give up while Claude may still fix it.
    if (isWorking(actions.forSession(session.sessionId).byItem.get(pr.key))) return;

    const decision = autoFixDecision(status, history);
    if (decision.action === 'queue') {
      const item = await this.#item(session, status, pr.key);
      const mainCheckout = (await this.deps.git.worktreeRoot(session.projectPath)) ?? session.projectPath;
      const result = await actions.request(session.sessionId, pr.key, 'fix-ci', 'auto', {
        resolved: {
          item,
          context: { repository: status.repository, mainCheckout, gh: 'ok' },
          checkName: decision.checkName,
          attempt: decision.attempt,
        },
      });
      if (!result.ok) {
        this.deps.log.info(`[pr-watch] auto-fix for ${pr.link.url} not queued: ${result.reason}`);
        return;
      }
      this.deps.log.info(`[pr-watch] auto-fix attempt ${decision.attempt} queued for ${pr.link.url} (${decision.checkName})`);
      this.deps.history.record({
        kind: 'attempt', repository: status.repository, number: status.number, checkName: decision.checkName,
        headSha: decision.headSha, origin: 'auto', activityId: result.activityId, at: this.#now(),
      });
    } else if (decision.action === 'give-up') {
      const attempts = autoFixAttempts(status, decision.checkName, history);
      this.#record(history, { kind: 'gave-up', repository: status.repository, number: status.number, checkName: decision.checkName });
      this.deps.log.info(`[pr-watch] auto-fix gave up on ${pr.link.url} (${decision.checkName})`);
      actions.giveUp(session.sessionId, pr.key, status.repository, { checkName: decision.checkName, attempts });
      this.deps.renderer.sessionNeedsAttention(session.sessionId);
    }
  }

  /** Store a passed or gave-up event, and add it to the history this poll decides on. */
  #record(history: AutoFixEvent[], event: Extract<AutoFixEvent, { kind: 'passed' | 'gave-up' }>): void {
    this.deps.history.record({ ...event, at: this.#now() });
    history.push(event);
  }

  /** The stored history of a PR, each attempt marked with whether Claude still has it. */
  #history(pr: WatchedPr): AutoFixEvent[] {
    return this.deps.history.forPullRequest(pr.repository, pr.link.number).map((record: AutoFixRecord): AutoFixEvent => {
      if (record.kind !== 'attempt') {
        return { kind: record.kind, repository: record.repository, number: record.number, checkName: record.checkName };
      }
      return {
        kind: 'attempt', repository: record.repository, number: record.number, checkName: record.checkName,
        headSha: record.headSha, origin: record.origin, inFlight: this.deps.actions.isInFlight(record.activityId),
      };
    });
  }

  /**
   * The PR as a work item, without the page: where the session worked on its
   * branch comes from the transcript, so the prompt names the right worktree.
   */
  async #item(session: WatchedSession, status: PullRequestStatus, key: string): Promise<SessionWorkItem> {
    let location: WorkLocation | null = null;
    if (session.folder && status.headRef) {
      const written = this.deps.transcripts.locations(session.folder, session.sessionId)
        .find((entry) => entry.branch === status.headRef);
      if (written) {
        const worktree = (await this.deps.git.worktreeRoot(written.cwd)) ?? written.cwd;
        location = { worktree, branch: written.branch, fromSubagent: written.fromSubagent };
      }
    }
    return {
      id: key,
      kind: 'pr',
      pr: status,
      location,
      diff: { kind: 'pull-request', repository: status.repository, number: status.number },
      activity: null,
    };
  }

  // ── The sidebar ──

  /** A session that stopped has no dots: what it last said would go stale. */
  #forgetStopped(sessions: readonly WatchedSession[]): void {
    const running = new Set(sessions.map((session) => session.sessionId));
    for (const sessionId of [...this.#published.keys()]) {
      if (running.has(sessionId)) continue;
      this.#published.delete(sessionId);
      this.deps.renderer.prStatusChanged({ sessionId, prs: [], needsYou: false });
    }
  }

  #publishAll(): void {
    const settled = new Set<string>();
    for (const session of this.#sessions) {
      for (const repository of this.#publish(session)) settled.add(repository);
    }
    // Claude finished with a PR: ask about it now rather than within the minute.
    if (settled.size > 0 && this.#interval) void this.#run(settled);
  }

  /**
   * Push the session's dots when they differ from what was pushed last, and
   * answer the repositories of its PRs whose action just finished.
   */
  #publish(session: WatchedSession): Set<string> {
    const activities = this.deps.actions.forSession(session.sessionId).byItem;
    const working = new Set<string>();
    for (const [key, activity] of activities) {
      if (isWorking(activity)) working.add(key);
    }
    const before = this.#working.get(session.sessionId);
    this.#working.set(session.sessionId, working);

    const settled = new Set<string>();
    const prs: PullRequestDot[] = [];
    let waiting = false;
    for (const pr of watchedPrs(session)) {
      if (before?.has(pr.key) && !working.has(pr.key)) {
        this.#settling.set(pr.link.url, this.#polls);
        settled.add(pr.repository);
      }
      const status = this.#latest.get(pr.link.url);
      if (!status) continue;
      const activity = activities.get(pr.key) ?? null;
      let dot = statusDot(status, activity);
      // What `gh` last said is from before Claude finished: not red yet.
      if (dot === 'red' && this.#settling.has(pr.link.url) && !needsYou(status, activity)) dot = 'amber';
      prs.push({ number: pr.link.number, dot });
      if (needsYou(status, activity)) waiting = true;
    }
    const key = JSON.stringify({ prs, waiting });
    const last = this.#published.get(session.sessionId);
    if (last === key || (last === undefined && prs.length === 0)) return settled;
    this.#published.set(session.sessionId, key);
    this.deps.renderer.prStatusChanged({ sessionId: session.sessionId, prs, needsYou: waiting });
    return settled;
  }

  #now(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }
}

/** A session's PR links, one per URL, each with its repository (from the URL when the link did not say). */
function watchedPrs(session: WatchedSession): WatchedPr[] {
  const seen = new Set<string>();
  const prs: WatchedPr[] = [];
  for (const link of session.pullRequests) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    const repository = link.repository || repositoryOf(link.url);
    if (repository) prs.push({ link, repository, key: 'pr:' + link.url });
  }
  return prs;
}

function repositoryOf(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(url);
  return match ? match[1] : '';
}
