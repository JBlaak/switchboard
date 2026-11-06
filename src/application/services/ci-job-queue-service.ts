/**
 * The CI job queue under a repository's merge queue: its reads, put together
 * by the `ci-job-queue` domain, and Bump.
 *
 * **Reads.** The repository's self-hosted runners, its running and queued
 * jobs, and the typical run time of each job: the median over the newest 20
 * successful runs of its workflow. A finished run's jobs never change, so
 * each timed run is kept (in memory, for as long as it is among its
 * workflow's newest 20) and only a new one costs a read. A busy runner with
 * none of the repository's jobs runs another repository's; when it was first
 * seen so is kept, since its job is expected to end a typical job's time
 * after. An answer is kept for as long as the overview's (30 s), so asking
 * again within that runs no `gh`; the renderer asks only while the Merge
 * queue section is on screen.
 *
 * **Bump.** The renderer asks with the runs it showed in its confirm. The
 * queue is read again, fresh, and only the runs that are still ahead of the
 * job (`bumpedRuns`) and that the confirm named are cancelled, one by one.
 * Once GitHub says one stopped (looked at every 5 s, for 2 minutes at most),
 * its failed and cancelled jobs are re-run, so they queue behind the job. A
 * refused call, or a run that did not stop in time, is noted on the bumped
 * job for 10 minutes and shows with the next read.
 */
import {
    bumpedRuns,
    ciJobQueue,
    jobOn,
    typicalJobTimes,
    TIMED_RUNS_PER_WORKFLOW,
    type BumpRequest,
    type BumpResult,
    type CiJob,
    type CiJobQueueAnswer,
    type TimedRun,
} from '../../domain/project/ci-job-queue';
import type {Clock, Timers} from '../ports/clock';
import type {CiJobQueueCalls, GitHubCli} from '../ports/github-cli';
import type {Logger} from '../ports/logger';
import {PLAN_CACHE_MS} from './plan-service';

/** How often a bump looks whether a run it cancelled has stopped. */
export const BUMP_LOOK_MS = 5_000;

/** How long a bump waits for a cancelled run to stop before giving up on re-running it. */
export const BUMP_WAIT_MS = 2 * 60_000;

/** How long what went wrong with a bump shows on the bumped job. */
export const BUMP_NOTE_MS = 10 * 60_000;

/** How many timed runs are read at once, so a first read does not fire 20 `gh` calls together. */
const TIMING_CONCURRENCY = 4;

export interface CiJobQueueServiceDeps {
    github: Pick<GitHubCli, CiJobQueueCalls>;
    clock: Clock;
    timers: Timers;
    log: Logger;
}

export class CiJobQueueService {
    /** Answers by repository while they are fresh. */
    private readonly fresh = new Map<string, {at: number; answer: Promise<CiJobQueueAnswer>}>();
    /** Timed runs by repository and run id. */
    private readonly timed = new Map<string, Map<number, TimedRun>>();
    /** When each runner was first seen busy with another repository's job, by repository. */
    private readonly otherSince = new Map<string, Map<string, number>>();
    /** Bump notes by repository and bumped job. */
    private readonly notes = new Map<string, Map<number, {text: string; at: number}>>();

    constructor(private readonly deps: CiJobQueueServiceDeps) {}

    /** The CI job queue of `repository`, from the last 30 s or read now. */
    public read(repository: string): Promise<CiJobQueueAnswer> {
        const now = this.deps.clock.now();
        const hit = this.fresh.get(repository);
        if (hit && now - hit.at < PLAN_CACHE_MS) return hit.answer.then((answer) => this.withNotes(repository, answer));
        const answer = this.readNow(repository).catch((err: unknown): CiJobQueueAnswer => ({
            ok: false,
            reason: (err as Error)?.message || 'GitHub did not answer',
        }));
        this.fresh.set(repository, {at: now, answer});
        void answer.then((settled) => {
            if (!settled.ok && this.fresh.get(repository)?.answer === answer) this.fresh.delete(repository);
        });
        return answer.then((settled) => this.withNotes(repository, settled));
    }

    /**
     * Bump: cancel the runs ahead of the job that the confirm named and are
     * still ahead, and re-run each once it stopped. Answers once they are
     * cancelled; the re-runs follow.
     */
    public async bump(request: BumpRequest): Promise<BumpResult> {
        const {repository, jobId} = request;
        this.fresh.delete(repository);
        const answer = await this.read(repository);
        if (!answer.ok) return answer;
        const runs = bumpedRuns(answer.pools, jobId, request.headNumbers).filter((job) =>
            request.runIds.includes(job.runId),
        );
        if (runs.length === 0) return {ok: false, reason: 'Nothing is queued ahead of it any more'};

        const since = this.deps.clock.now();
        const cancelled: CiJob[] = [];
        for (const job of runs) {
            const write = await this.deps.github.cancelRun(repository, job.runId);
            if (!write.ok) {
                for (const done of cancelled) this.rerunOnceStopped(repository, done, jobId, since);
                const reason = `Cancelling ${job.workflow} on ${jobOn(job)}: ${write.reason}`;
                this.note(repository, jobId, reason);
                this.deps.log.warn(`[ci-job-queue] bump of job ${jobId} in ${repository}: ${reason}`);
                return {ok: false, reason};
            }
            cancelled.push(job);
        }
        for (const job of cancelled) this.rerunOnceStopped(repository, job, jobId, since);
        this.fresh.delete(repository);
        return {ok: true, runs: cancelled.length};
    }

    // ── Reads ──

    private async readNow(repository: string): Promise<CiJobQueueAnswer> {
        const {github, clock} = this.deps;
        const [runners, jobs] = await Promise.all([github.selfHostedRunners(repository), github.ciJobs(repository)]);
        if (jobs === null) return {ok: false, reason: 'GitHub did not answer for the CI jobs'};
        const selfHosted = jobs.filter((job) => job.labels.some((label) => label.toLowerCase() === 'self-hosted'));
        const history = await this.history(repository, selfHosted);
        const now = clock.now();
        const known = this.followOthers(repository, runners ?? [], selfHosted, now);
        const pools = ciJobQueue({
            jobs: selfHosted,
            runners: runners ?? [],
            typical: typicalJobTimes(history),
            otherSince: (runner) => known.get(runner) ?? null,
            now,
        });
        return {ok: true, pools, fetchedAt: now, notes: {}};
    }

    /**
     * The timed runs of each workflow with a self-hosted job now, newest first:
     * kept ones as they were, new ones read. A workflow whose runs could not
     * be listed keeps what was timed of it.
     */
    private async history(repository: string, jobs: readonly CiJob[]): Promise<TimedRun[]> {
        const kept = this.timed.get(repository) ?? new Map<number, TimedRun>();
        const workflows = [...new Set(jobs.map((job) => job.workflowId).filter((id) => id > 0))];
        const next = new Map<number, TimedRun>();
        const history: TimedRun[] = [];
        for (const workflowId of workflows) {
            const ids = await this.deps.github.successfulRuns(repository, workflowId, TIMED_RUNS_PER_WORKFLOW);
            if (ids === null) {
                const before = [...kept.values()].filter((run) => run.workflowId === workflowId);
                for (const run of before) next.set(run.runId, run);
                history.push(...before);
                continue;
            }
            const timed = await mapLimited(ids, TIMING_CONCURRENCY, async (runId) =>
                kept.has(runId) ? kept.get(runId)! : this.deps.github.runJobTimes(repository, runId, workflowId),
            );
            for (const run of timed) {
                if (!run) continue;
                next.set(run.runId, run);
                history.push(run);
            }
        }
        // A workflow with no self-hosted job now keeps its timed runs, so its jobs coming back cost no reads.
        for (const run of kept.values()) {
            if (!workflows.includes(run.workflowId)) next.set(run.runId, run);
        }
        this.timed.set(repository, next);
        return history;
    }

    /** When each busy runner without one of `jobs` was first seen so; forgets the ones that are not any more. */
    private followOthers(
        repository: string,
        runners: readonly {name: string; busy: boolean}[],
        jobs: readonly CiJob[],
        now: number,
    ): Map<string, number> {
        const before = this.otherSince.get(repository) ?? new Map<string, number>();
        const next = new Map<string, number>();
        for (const runner of runners) {
            if (!runner.busy || jobs.some((job) => job.status === 'running' && job.runner === runner.name)) continue;
            next.set(runner.name, before.get(runner.name) ?? now);
        }
        this.otherSince.set(repository, next);
        return next;
    }

    // ── Bump ──

    /** Look whether a cancelled run has stopped, every 5 s for 2 minutes at most, then re-run its failed jobs. */
    private rerunOnceStopped(repository: string, job: CiJob, bumpedId: number, since: number): void {
        const {github, clock, timers, log} = this.deps;
        timers.setTimeout(() => {
            void (async () => {
                const stopped = await github.runCompleted(repository, job.runId).catch(() => null);
                if (stopped !== true) {
                    if (clock.now() - since < BUMP_WAIT_MS) {
                        this.rerunOnceStopped(repository, job, bumpedId, since);
                    } else {
                        this.note(
                            repository,
                            bumpedId,
                            `${job.workflow} on ${jobOn(job)} did not stop within 2 minutes, so it was not run again`,
                        );
                    }
                    return;
                }
                const write = await github
                    .rerunFailedJobs(repository, job.runId)
                    .catch((err: unknown) => ({ok: false as const, reason: (err as Error)?.message || 'no answer'}));
                if (!write.ok) {
                    this.note(repository, bumpedId, `Running ${job.workflow} on ${jobOn(job)} again: ${write.reason}`);
                    log.warn(`[ci-job-queue] re-run of run ${job.runId} in ${repository}: ${write.reason}`);
                }
                this.fresh.delete(repository);
            })();
        }, BUMP_LOOK_MS);
    }

    private note(repository: string, jobId: number, text: string): void {
        const notes = this.notes.get(repository) ?? new Map<number, {text: string; at: number}>();
        notes.set(jobId, {text, at: this.deps.clock.now()});
        this.notes.set(repository, notes);
        this.fresh.delete(repository);
    }

    /** The answer with the bump notes of the last 10 minutes. */
    private withNotes(repository: string, answer: CiJobQueueAnswer): CiJobQueueAnswer {
        if (!answer.ok) return answer;
        const now = this.deps.clock.now();
        const notes: Record<number, string> = {};
        const kept = this.notes.get(repository);
        for (const [jobId, note] of kept ?? []) {
            if (now - note.at < BUMP_NOTE_MS) notes[jobId] = note.text;
            else kept!.delete(jobId);
        }
        return {...answer, notes};
    }
}

/** `fn` over `items`, at most `limit` at a time, answers in their order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
    return results;
}
