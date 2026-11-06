/**
 * The CI job queue under a repository's merge queue: every running and queued
 * job of its Actions runs on self-hosted runners, by runner pool, with when
 * each queued job is expected to get a runner, and what a Bump of one moves.
 *
 * **Runner pools.** A job fits a runner that carries every label it asks for
 * (in any case, as GitHub matches them). Online runners whose labels hold one
 * another's make one pool, so a job that fits the smaller one fits the bigger
 * one too and both serve one wait. A pool is named by the labels its runners
 * share, `self-hosted` left out. Each runner process is one slot.
 *
 * **Runner wait.** GitHub does not say in what order its runners take jobs, so
 * it is taken as first come, first served: each slot is free now, or once its
 * running job's typical run time since its start has passed. The queued jobs,
 * oldest first, each take the slot that comes free first among the runners
 * they fit, which is then free once that job's typical run time has passed. A
 * job past its typical time is expected to end any moment, so what waits
 * behind it is a lower bound. A runner GitHub calls busy without a job of
 * this repository runs another repository's: it is expected to end a typical
 * job of its pool after it was first seen busy. After a job whose typical
 * time is unknown, its slot has no time either.
 *
 * **Typical run time.** A job's run time is from its start on a runner to its
 * end, without its wait for one. Its typical run time is the median over the
 * newest 20 successful runs of its workflow that ran a job by its name.
 *
 * **Bump.** GitHub keeps no priority for queued jobs. A bump cancels the runs
 * of the queued jobs ahead of a job in its pool and, once GitHub says each
 * stopped, re-runs their failed and cancelled jobs, which then queue behind
 * it. Cancelling a run stops every job in it, so a run with a job running is
 * left alone, and so are the bumped job's own run, the merge queue's own
 * passes and the queue head's CI (the queue would fail the head).
 *
 * Pure: the reads are `GitHubCli`'s, the sequence `CiJobQueueService`'s.
 */

/** How many of a workflow's newest successful runs its job times go by. */
export const TIMED_RUNS_PER_WORKFLOW = 20;

/** The workflow name of the merge queue's own passes, whose runs are never cancelled. */
export const QUEUE_PASS_WORKFLOW = 'Merge queue';

// ── What is read ──

/** One self-hosted runner. */
export interface Runner {
    name: string;
    labels: readonly string[];
    /** Whether GitHub says it runs a job now. */
    busy: boolean;
    online: boolean;
}

/** What a job runs for: an open PR, or a branch with none (the trunk, say). */
export type JobTarget = {kind: 'pr'; number: number; title: string} | {kind: 'branch'; branch: string};

/** A running or queued job of one of the repository's Actions runs. */
export interface CiJob {
    id: number;
    /** The run it belongs to, which a bump cancels and re-runs as a whole. */
    runId: number;
    url: string;
    /** Its run's workflow, such as `CI`. */
    workflow: string;
    workflowId: number;
    name: string;
    status: 'queued' | 'running';
    /** Epoch ms it was queued. */
    createdAt: number;
    /** Epoch ms it started on a runner; null while queued. */
    startedAt: number | null;
    /** The runner it runs on; null while queued. */
    runner: string | null;
    /** The runner labels it asks for, such as `self-hosted` and `macOS`. */
    labels: readonly string[];
    on: JobTarget;
    /** Who started its run; null when GitHub did not say. */
    actor: string | null;
}

/** One successful run, its jobs timed. */
export interface TimedRun {
    runId: number;
    workflowId: number;
    /** Each succeeded job's run time by its name, ms. */
    jobs: Readonly<Record<string, number>>;
}

/** A job's typical run time, ms; null while none of its workflow's timed runs ran it. */
export type TypicalTime = (workflowId: number, name: string) => number | null;

// ── Typical run times ──

/**
 * The typical run times from a repository's timed runs: per workflow and job
 * name, the median over the newest `TIMED_RUNS_PER_WORKFLOW` of that
 * workflow's runs (`runs` newest first).
 */
export function typicalJobTimes(runs: readonly TimedRun[]): TypicalTime {
    const newest = new Map<number, TimedRun[]>();
    for (const run of runs) {
        const of = newest.get(run.workflowId) ?? [];
        if (of.length < TIMED_RUNS_PER_WORKFLOW) of.push(run);
        newest.set(run.workflowId, of);
    }
    return (workflowId, name) =>
        median((newest.get(workflowId) ?? []).flatMap((run) => (name in run.jobs ? [run.jobs[name]] : [])));
}

// ── Runner pools ──

/** Whether a job asking for `labels` can run on `runner`. */
export function fits(labels: readonly string[], runner: Pick<Runner, 'labels'>): boolean {
    return holds(runner.labels, labels);
}

export interface RunnerPool {
    /** The labels every runner in it carries, `self-hosted` left out: `macOS · ARM64`. */
    name: string;
    runners: Runner[];
}

/** The pools of the online runners, in the order their first runner comes. */
export function runnerPools(runners: readonly Runner[]): RunnerPool[] {
    const online = runners.filter((runner) => runner.online);
    // Runners join through any runner they share a pool with, so a chain of label subsets makes one pool.
    const root = online.map((_, index) => index);
    const find = (index: number): number => (root[index] === index ? index : (root[index] = find(root[index])));
    online.forEach((a, i) =>
        online.forEach((b, j) => {
            if (j > i && (holds(a.labels, b.labels) || holds(b.labels, a.labels))) root[find(j)] = find(i);
        }),
    );
    const pools = new Map<number, Runner[]>();
    online.forEach((runner, index) => pools.set(find(index), [...(pools.get(find(index)) ?? []), runner]));
    return [...pools.values()].map((members) => ({name: sharedLabels(members).join(' · '), runners: members}));
}

// ── The CI job queue ──

/** A job in its pool: when it is expected to start (queued) and to end; null when nobody can tell. */
export interface JobRow {
    kind: 'job';
    job: CiJob;
    /** Epoch ms; for a running job, when it started. */
    startsAt: number | null;
    endsAt: number | null;
    /** Whether a job ahead ran past its typical time, so these times are the earliest they can be. */
    lowerBound: boolean;
}

/** A runner busy with another repository's job, and when that is expected to end. */
export interface OtherRow {
    kind: 'other';
    runner: string;
    endsAt: number | null;
    lowerBound: boolean;
}

export type JobQueueRow = JobRow | OtherRow;

/** A runner pool and its rows: running jobs, then other repositories', then queued ones in turn. */
export interface JobPool {
    name: string;
    runners: {name: string; busy: boolean}[];
    rows: JobQueueRow[];
}

export interface JobQueueInput {
    /** The repository's running and queued jobs, on any runner. */
    jobs: readonly CiJob[];
    runners: readonly Runner[];
    typical: TypicalTime;
    /** When a runner was first seen busy with a job that is not one of `jobs`; now when not known. */
    otherSince: (runner: string) => number | null;
    now: number;
}

interface Slot {
    runner: Runner;
    /** When it comes free; null after a job whose time is unknown. */
    freeAt: number | null;
    lowerBound: boolean;
}

/**
 * The runner pools of the online runners, then a pool per label set that no
 * online runner fits. Jobs on GitHub's own runners (without `self-hosted`)
 * are left out.
 */
export function ciJobQueue({jobs, runners, typical, otherSince, now}: JobQueueInput): JobPool[] {
    const groups = runnerPools(runners);
    const selfHosted = jobs.filter((job) => job.labels.some((label) => label.toLowerCase() === 'self-hosted'));
    const pools = groups.map((group) => ({
        group,
        running: [] as JobQueueRow[],
        other: [] as JobQueueRow[],
        queued: [] as JobQueueRow[],
    }));
    const unfit = new Map<string, JobQueueRow[]>();
    const slots = new Map<string, Slot>();
    const timeOf = (job: CiJob): number | null => typical(job.workflowId, job.name);

    const poolOf = (job: CiJob): (typeof pools)[number] | undefined => {
        const onRunner =
            job.runner === null
                ? undefined
                : pools.find(({group}) => group.runners.some((r) => r.name === job.runner && fits(job.labels, r)));
        if (onRunner) return onRunner;
        const fitting = pools.map((pool) => pool.group.runners.filter((r) => fits(job.labels, r)).length);
        const most = Math.max(0, ...fitting);
        return most === 0 ? undefined : pools[fitting.indexOf(most)];
    };
    const place = (job: CiJob, row: JobQueueRow, into: 'running' | 'queued'): void => {
        const pool = poolOf(job);
        if (pool) {
            pool[into].push(row);
            return;
        }
        const key = job.labels.filter((label) => label.toLowerCase() !== 'self-hosted').join(' · ');
        unfit.set(key, [...(unfit.get(key) ?? []), row]);
    };

    for (const {group} of pools) {
        for (const runner of group.runners) slots.set(runner.name, {runner, freeAt: now, lowerBound: false});
    }

    const running = selfHosted
        .filter((job) => job.status === 'running')
        .sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt));
    for (const job of running) {
        const time = timeOf(job);
        const end = time === null ? null : (job.startedAt ?? job.createdAt) + time;
        const lowerBound = end !== null && end < now;
        const endsAt = end === null ? null : Math.max(end, now);
        place(job, {kind: 'job', job, startsAt: job.startedAt ?? job.createdAt, endsAt, lowerBound}, 'running');
        const slot = job.runner === null ? undefined : slots.get(job.runner);
        if (slot && fits(job.labels, slot.runner)) slots.set(slot.runner.name, {...slot, freeAt: endsAt, lowerBound});
    }

    const ours = (runner: Runner): boolean =>
        running.some((job) => job.runner === runner.name && fits(job.labels, runner));
    for (const pool of pools) {
        const poolTime = median(
            selfHosted
                .filter((job) => poolOf(job) === pool)
                .map(timeOf)
                .filter((time): time is number => time !== null),
        );
        for (const runner of pool.group.runners) {
            if (!runner.busy || ours(runner)) continue;
            const since = otherSince(runner.name) ?? now;
            const end = poolTime === null ? null : since + poolTime;
            const lowerBound = end !== null && end < now;
            const endsAt = end === null ? null : Math.max(end, now);
            pool.other.push({kind: 'other', runner: runner.name, endsAt, lowerBound});
            slots.set(runner.name, {runner, freeAt: endsAt, lowerBound});
        }
    }

    const queued = selfHosted
        .filter((job) => job.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    for (const job of queued) {
        const free = [...slots.values()]
            .filter((slot) => slot.freeAt !== null && fits(job.labels, slot.runner))
            .sort((a, b) => a.freeAt! - b.freeAt!)[0];
        if (!free) {
            place(job, {kind: 'job', job, startsAt: null, endsAt: null, lowerBound: false}, 'queued');
            continue;
        }
        const time = timeOf(job);
        const startsAt = free.freeAt!;
        const endsAt = time === null ? null : startsAt + time;
        place(job, {kind: 'job', job, startsAt, endsAt, lowerBound: free.lowerBound}, 'queued');
        slots.set(free.runner.name, {runner: free.runner, freeAt: endsAt, lowerBound: free.lowerBound});
    }

    return [
        ...pools.map(({group, running: runningRows, other, queued: queuedRows}) => ({
            name: group.name,
            runners: group.runners.map((runner) => ({name: runner.name, busy: runner.busy || ours(runner)})),
            rows: [...runningRows, ...other, ...queuedRows],
        })),
        ...[...unfit].map(([name, rows]) => ({name, runners: [], rows})),
    ];
}

/** A queued job's expected runner wait from now, ms: until it is expected to start; null when nobody can tell. */
export function expectedWaitMs(row: JobRow, now: number): number | null {
    if (row.job.status !== 'queued' || row.startsAt === null) return null;
    return Math.max(0, row.startsAt - now);
}

// ── Across the process boundary ──

export type CiJobQueueAnswer =
    | {
          ok: true;
          /** Empty when the repository has no self-hosted runner or job to show. */
          pools: JobPool[];
          fetchedAt: number;
          /** What went wrong with a bump, by the bumped job's id. */
          notes: Record<number, string>;
      }
    | {ok: false; reason: string};

export interface BumpRequest {
    repository: string;
    /** The queued job to move ahead. */
    jobId: number;
    /** The runs the confirm named: no other run is touched. */
    runIds: readonly number[];
    /** The queue head's PRs (a stack's members), whose CI is never cancelled. */
    headNumbers: readonly number[];
}

export type BumpResult = {ok: true; runs: number} | {ok: false; reason: string};

// ── Bump ──

/**
 * One job of each run a bump of the queued job `targetId` cancels and re-runs,
 * in the order its pool shows them: the queued jobs ahead of it, leaving out
 * any run with a job running (cancelling it would stop that job), its own
 * run, the merge queue's own passes and the CI of the queue head's PRs
 * (`headNumbers`). Nothing unless the job is queued.
 */
export function bumpedRuns(pools: readonly JobPool[], targetId: number, headNumbers: readonly number[]): CiJob[] {
    const pool = pools.find((candidate) => candidate.rows.some((row) => row.kind === 'job' && row.job.id === targetId));
    const target = pool?.rows.find((row): row is JobRow => row.kind === 'job' && row.job.id === targetId)?.job;
    if (!pool || !target || target.status !== 'queued') return [];
    const runningRuns = new Set(
        pools.flatMap((each) =>
            each.rows.flatMap((row) => (row.kind === 'job' && row.job.status === 'running' ? [row.job.runId] : [])),
        ),
    );
    const ahead: CiJob[] = [];
    for (const row of pool.rows) {
        if (row.kind !== 'job') continue;
        const {job} = row;
        if (job.id === targetId) break;
        if (job.status !== 'queued' || runningRuns.has(job.runId)) continue;
        if (job.runId === target.runId || isQueuePass(job) || isHeadJob(job, headNumbers)) continue;
        if (ahead.some((other) => other.runId === job.runId)) continue;
        ahead.push(job);
    }
    return ahead;
}

/** Whether a job is of the merge queue's own pass, which is never cancelled. */
export function isQueuePass(job: Pick<CiJob, 'workflow'>): boolean {
    return job.workflow.toLowerCase() === QUEUE_PASS_WORKFLOW.toLowerCase();
}

/** Whether a job is CI of the queue head: of its PR, or a member of its stack. */
export function isHeadJob(job: Pick<CiJob, 'on'>, headNumbers: readonly number[]): boolean {
    return job.on.kind === 'pr' && headNumbers.includes(job.on.number);
}

/** What a job runs for, as the page names it: "#12 Title", or its branch. */
export function jobOn(job: Pick<CiJob, 'on'>): string {
    return job.on.kind === 'pr' ? `#${job.on.number} ${job.on.title}` : job.on.branch;
}

/**
 * The plain confirm a bump always asks first: the runs it cancels and
 * re-runs, whose each is, and that GitHub promises no order.
 */
export function bumpConfirm(target: CiJob, runs: readonly CiJob[]): string {
    const named = runs.map((job) => `• ${job.workflow} on ${jobOn(job)}${job.actor ? ` (${job.actor})` : ''}`);
    const count = runs.length === 1 ? '1 run so it queues' : `${runs.length} runs so they queue`;
    return [
        `Bump ${target.name} on ${jobOn(target)}?`,
        '',
        `This cancels and re-runs ${count} behind it:`,
        ...named,
        '',
        'They may be other people’s runs. GitHub cancels a run as a whole and does not promise to hand out runners in order.',
    ].join('\n');
}

// ── Support ──

function sharedLabels(runners: readonly Runner[]): string[] {
    const [first, ...rest] = runners;
    return (first?.labels ?? []).filter(
        (label) => label.toLowerCase() !== 'self-hosted' && rest.every((runner) => holds(runner.labels, [label])),
    );
}

function holds(labels: readonly string[], wanted: readonly string[]): boolean {
    const have = new Set(labels.map((label) => label.toLowerCase()));
    return wanted.every((label) => have.has(label.toLowerCase()));
}

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
