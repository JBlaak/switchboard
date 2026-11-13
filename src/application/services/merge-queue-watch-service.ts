/**
 * The merge queue outside the project page (#315): the queue of every
 * repository a running session is in, kept up to date whether or not its
 * project page is open, for the sidebar's pills and the session header's
 * panel.
 *
 * On the CI watch's cadence (once a minute, and when the window gets focus)
 * it asks the project overview for each running session's project, without
 * plans: the cheap answer, which shares the page's 30 s cache, so a page open
 * on the same project costs no second `gh` read. For a repository that uses
 * the queue it pushes the queue and its errands (`mergeQueueChanged`) when
 * they changed, estimates aside (they count down on every read and nothing
 * outside the page shows them). A repository that stops using the queue, or
 * that no running session is in any more, is pushed once as `queue: null`.
 *
 * Every read is a GraphQL request, and most repositories have no queue:
 * before the watch, nothing outside an open project page read them. So a
 * repository whose open PRs showed no queue is asked again only every
 * `QUEUE_RECHECK_MS`, not every minute; one that starts using the queue shows
 * up within that.
 *
 * Each reading of a queue also settles its nudges (`settleNudges`): a nudge
 * whose review request is no longer among the held entries may go again, so
 * a re-requested review offers Nudge again without the project page open.
 *
 * It notifies nothing: what merged and what needs you is the Merge manager's
 * to show (#432), never a macOS notification.
 */
import {PR_WATCH_INTERVAL_MS} from './pr-watch-service';
import {queueChangeSignature, type MergeQueueChange} from '../../domain/project/queue-elsewhere';
import type {MergeQueue} from '../../domain/project/merge-queue';
import {heldForReview} from '../../domain/project/queue-errands';
import type {SessionPullRequest} from '../../domain/session/session';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {ProjectOverviewService} from './project-overview-service';
import type {QueueErrandService} from './queue-errand-service';

/**
 * How often a repository whose open PRs showed no queue is read again. A
 * quarter of an hour: a repository rarely starts using the queue, and the
 * pills of the one that does can wait that long.
 */
export const QUEUE_RECHECK_MS = 15 * 60_000;

/** A running session, as the queue watch needs it. */
export interface QueueWatchedSession {
    sessionId: string;
    projectPath: string;
    /** The PRs its transcript linked, chronological. */
    pullRequests: readonly SessionPullRequest[];
}

export interface MergeQueueWatchServiceDeps {
    /** The running Claude sessions (local and VM ones; not on an agentless remote). */
    sessions(): QueueWatchedSession[];
    overview: Pick<ProjectOverviewService, 'overview'>;
    errands: Pick<QueueErrandService, 'errands' | 'settleNudges'>;
    renderer: Pick<RendererGateway, 'mergeQueueChanged'>;
    timers: Timers;
    clock: Clock;
    log: Logger;
}

export class MergeQueueWatchService {
    private interval: TimerHandle | null = null;
    private polling: Promise<void> | null = null;
    /** A poll asked for while one ran: run once more after it. */
    private again = false;
    /** Each project path's repository, as the overview last answered it (null: none on GitHub). */
    private readonly repositoryOf = new Map<string, string | null>();
    /** What was last pushed per repository (`queueChangeSignature`). */
    private readonly published = new Map<string, string>();
    /** Repositories whose open PRs showed no queue, by when (epoch ms): read again after QUEUE_RECHECK_MS. */
    private readonly withoutQueue = new Map<string, number>();

    constructor(private readonly deps: MergeQueueWatchServiceDeps) {}

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

    /** The window got focus: poll once more, when the watch is on. */
    public focused(): void {
        if (this.interval) void this.poll();
    }

    /** Read every running session's repository's queue, and push what changed. */
    public poll(): Promise<void> {
        if (this.polling) {
            this.again = true;
            return this.polling;
        }
        this.polling = this.pollOnce()
            .catch((err) => this.deps.log.error('[merge-queue] polling failed:', (err as Error).message))
            .finally(() => {
                this.polling = null;
                if (this.again) {
                    this.again = false;
                    void this.poll();
                }
            });
        return this.polling;
    }

    private async pollOnce(): Promise<void> {
        const sessions = this.deps.sessions();
        const paths = [...new Set(sessions.map((session) => session.projectPath))];
        const seen = new Set<string>();
        for (const path of paths) {
            // A repository is read once a poll, through the first of its paths.
            const known = this.repositoryOf.get(path);
            if (known !== undefined && (known === null || seen.has(known))) continue;
            if (known && this.recentlyWithoutQueue(known)) {
                seen.add(known);
                continue;
            }
            try {
                const answer = await this.deps.overview.overview(path, {plans: false});
                this.repositoryOf.set(path, answer.repository);
                const repository = answer.repository;
                if (!repository || seen.has(repository)) continue;
                seen.add(repository);
                // Unavailable: what was pushed last stands.
                if (!answer.github?.ok) continue;
                if (answer.github.mergeQueue) this.withoutQueue.delete(repository);
                else this.withoutQueue.set(repository, this.deps.clock.now());
                this.take(repository, answer.github.mergeQueue);
            } catch (err) {
                this.deps.log.error(`[merge-queue] reading ${path} failed:`, (err as Error).message);
                if (known) seen.add(known);
            }
        }
        // Nothing runs in it any more: its pills go.
        for (const repository of [...this.published.keys()]) {
            if (!seen.has(repository)) this.take(repository, null);
        }
    }

    /** Did the repository's open PRs show no queue less than QUEUE_RECHECK_MS ago? */
    private recentlyWithoutQueue(repository: string): boolean {
        const at = this.withoutQueue.get(repository);
        return at !== undefined && this.deps.clock.now() - at < QUEUE_RECHECK_MS;
    }

    /** One repository's fresh queue: push it when it changed. */
    private take(repository: string, queue: MergeQueue | null): void {
        // Before its errands are read, so a nudge whose request changed is pushed settled.
        if (queue) this.deps.errands.settleNudges(repository, heldForReview(queue));
        const errands = queue ? this.deps.errands.errands(repository) : [];
        const signature = queueChangeSignature(queue, errands);
        const pushed = this.published.get(repository);
        if (pushed === signature || (pushed === undefined && !queue)) return;
        if (queue) this.published.set(repository, signature);
        else this.published.delete(repository);
        const change: MergeQueueChange = {repository, queue, errands};
        this.deps.renderer.mergeQueueChanged(change);
    }
}
