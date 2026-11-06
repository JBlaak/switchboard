/**
 * The CI job queue's REST reads: the paths `GhCli` asks with `gh api`, and how
 * each answer maps onto the `ci-job-queue` domain.
 *
 * Kept apart from `gh-cli.ts`, like `gh-overview.ts`, so the mapping can be
 * tested from recorded answers on its own. Answers are read field by field
 * with a fallback for each, so they are typed `any`.
 *
 * A run belongs to the open PR GitHub names on it, or else to the open PR
 * whose branch it ran on (GitHub leaves `pull_requests` empty on a run a
 * workflow dispatched), or else to its branch.
 */
import type {CiJob, JobTarget, Runner, TimedRun} from '../../domain/project/ci-job-queue';

/** Runs listed to find the unfinished ones. */
export const RUNS_LISTED = 50;

/** The statuses of a run or job that has not finished; `in_progress` is the one that runs. */
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export const ciJobPaths = {
    repoRunners: (repo: string) => `repos/${repo}/actions/runners?per_page=100`,
    orgRunners: (owner: string) => `orgs/${owner}/actions/runners?per_page=100`,
    runs: (repo: string) => `repos/${repo}/actions/runs?per_page=${RUNS_LISTED}`,
    pulls: (repo: string) => `repos/${repo}/pulls?state=open&per_page=100`,
    jobs: (repo: string, runId: number) => `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    run: (repo: string, runId: number) => `repos/${repo}/actions/runs/${runId}`,
    successfulRuns: (repo: string, workflowId: number, count: number) =>
        `repos/${repo}/actions/workflows/${workflowId}/runs?status=success&per_page=${count}`,
    cancel: (repo: string, runId: number) => `repos/${repo}/actions/runs/${runId}/cancel`,
    rerunFailed: (repo: string, runId: number) => `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`,
};

/** The runners in an answer of `actions/runners`; null for an answer of another shape. */
export function toRunners(body: any): Runner[] | null {
    if (!Array.isArray(body?.runners)) return null;
    return body.runners
        .filter((runner: any) => typeof runner?.name === 'string')
        .map((runner: any): Runner => ({
            name: runner.name,
            labels: (Array.isArray(runner.labels) ? runner.labels : [])
                .map((label: any) => label?.name)
                .filter((name: unknown): name is string => typeof name === 'string'),
            busy: runner.busy === true,
            online: runner.status === 'online',
        }));
}

/** An unfinished run, as its jobs need it. */
export interface ActiveRun {
    id: number;
    workflow: string;
    workflowId: number;
    on: JobTarget;
    actor: string | null;
}

/** The unfinished runs in an answer of `actions/runs`, each with what it runs for, from the open PRs in `pulls`. */
export function toActiveRuns(runs: any, pulls: any): ActiveRun[] | null {
    if (!Array.isArray(runs?.workflow_runs)) return null;
    const open: any[] = Array.isArray(pulls) ? pulls : [];
    const byNumber = new Map<number, any>(open.filter((p) => typeof p?.number === 'number').map((p) => [p.number, p]));
    const byBranch = new Map<string, any>(
        open.filter((p) => typeof p?.head?.ref === 'string').map((p) => [p.head.ref, p]),
    );
    return runs.workflow_runs
        .filter((run: any) => typeof run?.id === 'number' && ACTIVE.has(run.status))
        .map((run: any): ActiveRun => {
            const named = (Array.isArray(run.pull_requests) ? run.pull_requests : [])
                .map((p: any) => p?.number)
                .find((number: unknown) => typeof number === 'number');
            const pull = (named !== undefined ? byNumber.get(named) : undefined) ?? byBranch.get(run.head_branch);
            const number = pull?.number ?? named;
            const on: JobTarget =
                typeof number === 'number'
                    ? {kind: 'pr', number, title: String(pull?.title ?? run.display_title ?? '')}
                    : {kind: 'branch', branch: typeof run.head_branch === 'string' ? run.head_branch : ''};
            return {
                id: run.id,
                workflow: typeof run.name === 'string' ? run.name : '',
                workflowId: typeof run.workflow_id === 'number' ? run.workflow_id : 0,
                on,
                actor: typeof run.actor?.login === 'string' ? run.actor.login : null,
            };
        });
}

/** The running and queued jobs in an answer of a run's `jobs`; none for an answer of another shape. */
export function toCiJobs(run: ActiveRun, body: any): CiJob[] {
    if (!Array.isArray(body?.jobs)) return [];
    return body.jobs
        .filter((job: any) => typeof job?.id === 'number' && ACTIVE.has(job.status))
        .map((job: any): CiJob => {
            const running = job.status === 'in_progress';
            const created = Date.parse(job.created_at);
            const started = Date.parse(job.started_at);
            return {
                id: job.id,
                runId: run.id,
                url: typeof job.html_url === 'string' ? job.html_url : '',
                workflow: run.workflow,
                workflowId: run.workflowId,
                name: typeof job.name === 'string' ? job.name : '',
                status: running ? 'running' : 'queued',
                createdAt: Number.isFinite(created) ? created : 0,
                startedAt: running && Number.isFinite(started) ? started : null,
                runner: running && typeof job.runner_name === 'string' && job.runner_name ? job.runner_name : null,
                labels: (Array.isArray(job.labels) ? job.labels : []).filter(
                    (label: unknown): label is string => typeof label === 'string',
                ),
                on: run.on,
                actor: run.actor,
            };
        });
}

/** The run ids in an answer of a workflow's `runs`, newest first; null for an answer of another shape. */
export function toRunIds(body: any): number[] | null {
    if (!Array.isArray(body?.workflow_runs)) return null;
    return body.workflow_runs.map((run: any) => run?.id).filter((id: unknown): id is number => typeof id === 'number');
}

/** A run timed from its `jobs` answer: each succeeded job's run time; null without one. */
export function toTimedRun(runId: number, workflowId: number, body: any): TimedRun | null {
    if (!Array.isArray(body?.jobs)) return null;
    const jobs: Record<string, number> = {};
    for (const job of body.jobs) {
        if (job?.conclusion !== 'success' || typeof job.name !== 'string') continue;
        const started = Date.parse(job.started_at);
        const completed = Date.parse(job.completed_at);
        if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) continue;
        jobs[job.name] = completed - started;
    }
    return Object.keys(jobs).length === 0 ? null : {runId, workflowId, jobs};
}

/** Whether a run's answer says it has stopped; null for an answer of another shape. */
export function toRunCompleted(body: any): boolean | null {
    return typeof body?.status === 'string' ? body.status === 'completed' : null;
}
