/**
 * The CI watch: every open PR of every running session, kept an eye on while
 * Switchboard runs, whether or not a Session work page is open (W1).
 *
 * Once a minute, and once more when the window gets focus, it asks `gh` about
 * them — one batched request per repository, however many sessions share it —
 * and does two things with the answer:
 *
 * - **Sidebar dots (W4).** Each PR's colour, pushed for the session's row only
 *   when it changed.
 * - **Stopping.** A merged or closed PR has nothing left to watch.
 *
 * It only reads: nothing is ever typed into a session.
 */
import {needsYou, statusDot, type PullRequestDot} from '../../domain/session-work/status';
import type {SessionPullRequest} from '../../domain/session/session';
import type {PullRequestStatus} from '../../domain/session-work/model';
import type {TimerHandle, Timers} from '../ports/clock';
import type {GitHubCli} from '../ports/github-cli';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';

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
    /** The PRs its transcript linked, chronological. */
    pullRequests: readonly SessionPullRequest[];
}

export interface PrWatchServiceDeps {
    /** The running Claude sessions (not plain terminals, not remote ones). */
    sessions(): WatchedSession[];
    github: Pick<GitHubCli, 'available' | 'pullRequests' | 'checkLogTail'>;
    renderer: Pick<RendererGateway, 'prStatusChanged'>;
    timers: Timers;
    log: Logger;
}

/** One PR link, with the repository it is in worked out. */
interface WatchedPr {
    link: SessionPullRequest;
    repository: string;
}

export class PrWatchService {
    private interval: TimerHandle | null = null;
    private polling: Promise<void> | null = null;
    /** The last answer `gh` gave about each PR, by URL. */
    private readonly latest = new Map<string, PullRequestStatus>();
    /** Merged and closed PRs, by URL: never asked about again. */
    private readonly finished = new Set<string>();
    /** The sessions watched as of the last poll. */
    private sessions: WatchedSession[] = [];
    /** What was last pushed for each session's row. */
    private readonly published = new Map<string, string>();
    /** Check logs already read, by check run URL: a finished run's log does not change. */
    private readonly logs = new Map<string, string | null>();
    constructor(private readonly deps: PrWatchServiceDeps) {}

    /** Poll now and every minute after. */
    public start(): void {
        if (this.interval) return;
        this.interval = this.deps.timers.setInterval(() => void this.poll(), PR_WATCH_INTERVAL_MS);
        void this.poll();
    }

    public stop(): void {
        this.deps.timers.clearInterval(this.interval);
        this.interval = null;
    }

    /** The window got focus: poll once more, when the watch is on (W1). */
    public focused(): void {
        if (this.interval) void this.poll();
    }

    /**
     * Ask `gh` about every open PR of every running session. A poll asked for
     * while one is running (a focus during the minute's) is that one.
     */
    public poll(): Promise<void> {
        if (this.polling) return this.polling;
        this.polling = this.pollAll()
            .catch((err) => this.deps.log.error('[pr-watch] polling failed:', (err as Error).message))
            .finally(() => {
                this.polling = null;
            });
        return this.polling;
    }

    /** A PR's state as `gh` last answered it, by URL; null when it never did. */
    public stateOf(url: string): PullRequestStatus['state'] | null {
        return this.latest.get(url)?.state ?? null;
    }

    /** What `gh` last answered about a PR, by URL; null when it never did (#340's links). */
    public statusOf(url: string): PullRequestStatus | null {
        return this.latest.get(url) ?? null;
    }

    /** The end of a check run's log, for the page's Checks panel. */
    public async checkLog(repository: string, checkRunUrl: string): Promise<string | null> {
        if (this.logs.has(checkRunUrl)) return this.logs.get(checkRunUrl) ?? null;
        const log = await this.deps.github.checkLogTail(repository, checkRunUrl, CHECK_LOG_LINES);
        if (log !== null) this.logs.set(checkRunUrl, log);
        return log;
    }

    private async pollAll(): Promise<void> {
        const sessions = this.deps.sessions();
        this.forgetStopped(sessions);
        this.sessions = sessions;

        // Each open PR once, under the first session that linked it.
        const owners = new Map<string, {session: WatchedSession; pr: WatchedPr}>();
        for (const session of sessions) {
            for (const pr of watchedPrs(session)) {
                if (!this.finished.has(pr.link.url) && !owners.has(pr.link.url)) owners.set(pr.link.url, {session, pr});
            }
        }
        if (owners.size === 0 || (await this.deps.github.available()) !== 'ok') {
            this.publishAll();
            return;
        }

        const byRepository = new Map<string, number[]>();
        for (const {pr} of owners.values()) {
            const numbers = byRepository.get(pr.repository) ?? [];
            numbers.push(pr.link.number);
            byRepository.set(pr.repository, numbers);
        }
        for (const [repository, numbers] of byRepository) {
            const answer = await this.deps.github.pullRequests(repository, numbers);
            for (const status of answer ?? []) {
                const owner = [...owners.values()].find(
                    ({pr}) => pr.repository === repository && pr.link.number === status.number,
                );
                if (!owner) continue;
                this.latest.set(owner.pr.link.url, {
                    ...status,
                    url: owner.pr.link.url,
                    repository: status.repository || repository,
                });
                if (status.state === 'merged' || status.state === 'closed') this.finished.add(owner.pr.link.url);
            }
        }
        this.publishAll();
    }

    // ── The sidebar ──

    /** A session that stopped has no dots: what it last said would go stale. */
    private forgetStopped(sessions: readonly WatchedSession[]): void {
        const running = new Set(sessions.map((session) => session.sessionId));
        for (const sessionId of [...this.published.keys()]) {
            if (running.has(sessionId)) continue;
            this.published.delete(sessionId);
            this.deps.renderer.prStatusChanged({sessionId, prs: [], needsYou: false});
        }
    }

    private publishAll(): void {
        for (const session of this.sessions) this.publish(session);
    }

    /** Push the session's dots when they differ from what was pushed last. */
    private publish(session: WatchedSession): void {
        const prs: PullRequestDot[] = [];
        let waiting = false;
        for (const pr of watchedPrs(session)) {
            const status = this.latest.get(pr.link.url);
            if (!status) continue;
            prs.push({
                number: pr.link.number,
                dot: statusDot(status),
                // What the sidebar needs to tell a session whose PRs land on their own (merging).
                ...(status.state === 'closed' ? {closed: true as const} : {}),
                ...(status.autoMerge && (status.state === 'open' || status.state === 'draft')
                    ? {autoMerge: true as const}
                    : {}),
            });
            if (needsYou(status)) waiting = true;
        }
        const key = JSON.stringify({prs, waiting});
        const last = this.published.get(session.sessionId);
        if (last === key || (last === undefined && prs.length === 0)) return;
        this.published.set(session.sessionId, key);
        this.deps.renderer.prStatusChanged({sessionId: session.sessionId, prs, needsYou: waiting});
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
        if (repository) prs.push({link, repository});
    }
    return prs;
}

function repositoryOf(url: string): string {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(url);
    return match ? match[1] : '';
}
