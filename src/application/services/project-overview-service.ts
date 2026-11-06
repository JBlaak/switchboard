/**
 * The project page's back end (#172): everything main knows about a project,
 * in one answer. Its GitHub repository, its plans, loose issues and pull
 * requests grouped by `groupOverview` (#170), its worktrees, and which issues
 * and worktrees have a session running.
 *
 * Plans are read through PlanService, so they share its 30 s cache; the
 * issues and PRs are kept here for as long, so a second ask within 30 s does
 * not run `gh` at all. Which sessions run and own which issue is asked fresh
 * every time, because that is local and changes by the second.
 *
 * Stale over empty: when a refresh fails after a good answer, the last good
 * answer is served marked stale, with when it was fetched. When there has
 * never been one, the answer says why: no `gh`, not signed in, or GitHub
 * could not be reached.
 *
 * A project without a GitHub remote answers only its local parts. An ssh
 * project on a host without a Switchboard agent answers its running sessions
 * only: no git and no `gh` reads. A VM project (its host has an agent, #276
 * stage 4) is read like a local one, through the git and `gh` its VM-named
 * paths route to the VM, and answers `remote: true` all the same.
 *
 * Asked with `plans: false`, it answers without the plans, the slow part:
 * the issues and PRs grouped without them and `plansPending` set, kept under
 * its own key. The page asks that and the full answer at once, so its pull
 * requests show before its plans. The two share their `gh` and git reads
 * while both are in flight, so asking both costs no second read.
 *
 * The merge queue (#315) is read with the rest and kept with it: the open
 * PRs' queue reads come in the same `gh` request as the PRs, and only a
 * repository whose PRs show the queue has its CI run durations read (one
 * more `gh` call) and its default branch asked of git. The queue itself is
 * worked out per answer, against the clock, so its estimates count down
 * while the reads are cached. It is on the `plans: false` answer too. Run
 * durations that could not be read leave the queue without estimates rather
 * than failing the answer.
 *
 * Its one write is the Worktrees section's Clean: removing the worktrees
 * `superfluousWorktrees` names, then `git worktree prune`. Never forced, so
 * git still refuses a dirty one, and their branches are kept. Not for an ssh
 * project, VM or not.
 */
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {gitHubRepository} from '../../domain/project/repo-url';
import {groupOverview, type OverviewPlanSource} from '../../domain/plan/project-overview';
import {mergeQueue, usesMergeQueue, type QueuePullRequest} from '../../domain/project/merge-queue';
import {superfluousWorktrees} from '../../domain/project/superfluous-worktrees';
import type {Plan} from '../../domain/plan/model';
import type {
    GitHubUnavailableReason,
    ProjectGitHubOverview,
    ProjectIssue,
    ProjectOverview,
    ProjectOverviewOptions,
    ProjectPullRequest,
    RepositoryIssue,
    RepositoryPullRequest,
    WorktreeCleanResult,
    WorktreeOverview,
    WorktreeSummary,
} from '../../domain/project/overview';
import type {Clock} from '../ports/clock';
import type {GitWorkspace, GitWorktrees} from '../ports/git-workspace';
import type {GitHubCli, ProjectReads} from '../ports/github-cli';
import type {GitRemotes} from '../ports/git-remotes';
import type {IssueSessionService} from './issue-session-service';
import {PLAN_CACHE_MS, type PlanService} from './plan-service';

/** A Claude session running now, and the directory it runs in. */
export interface RunningSession {
    sessionId: string;
    projectPath: string;
}

export interface ProjectOverviewServiceDeps {
    plans: Pick<PlanService, 'projectPlans' | 'plan'>;
    /** Which session owns which issue (S1). */
    owners: Pick<IssueSessionService, 'issueSessions'>;
    /** The Claude sessions running now; plain terminals are not sessions. */
    running(): RunningSession[];
    git: Pick<GitWorkspace, 'worktreeRoot' | 'worktrees' | 'defaultBranch'>;
    /** Clean's writes: the worktrees removed, and pruned after. */
    worktreeWrites: Pick<GitWorktrees, 'mainCheckout' | 'removeWorktree' | 'pruneWorktrees'>;
    remotes: GitRemotes;
    github: Pick<GitHubCli, 'available' | ProjectReads>;
    clock: Clock;
    /**
     * Whether a path is on a remote with no Switchboard agent, which gets the
     * sessions-only answer. Without it, every remote does, as before #276 stage 4.
     */
    agentlessRemote?: (path: string) => boolean;
}

/** What `gh` answered for a repository, before it is grouped. */
interface GitHubReads {
    fetchedAt: number;
    plans: OverviewPlanSource[];
    issues: ProjectIssue[];
    /** Open ones, merged ones when asked for, and the ones merged or closed most recently. */
    pullRequests: ProjectPullRequest[];
    /** What the merge queue is worked out from; null when the repository does not use one. */
    queue: QueueReads | null;
}

/** A merge queue's reads: everything `mergeQueue` takes but the time. */
interface QueueReads {
    trunk: string;
    pullRequests: QueuePullRequest[];
    ciRunDurationsMs: number[];
}

export class ProjectOverviewService {
    /** Reads by repository and options, while they are fresh; a failed read is dropped once it lands. */
    private readonly fresh = new Map<string, {at: number; reads: Promise<GitHubReads | null>}>();
    /** The last good reads by repository and options, for when a refresh fails. */
    private readonly last = new Map<string, GitHubReads>();

    private readonly deps: ProjectOverviewServiceDeps;

    constructor(deps: ProjectOverviewServiceDeps) {
        const {github, git} = deps;
        this.deps = {
            ...deps,
            github: {
                available: () => github.available(),
                issuesIn: inFlightShared((repository, options) => github.issuesIn(repository, options)),
                pullRequestsIn: inFlightShared((repository, options) => github.pullRequestsIn(repository, options)),
                ciRunDurations: inFlightShared((repository) => github.ciRunDurations(repository)),
            },
            git: {
                worktreeRoot: (cwd) => git.worktreeRoot(cwd),
                worktrees: inFlightShared((root) => git.worktrees(root)),
                defaultBranch: inFlightShared((root) => git.defaultBranch(root)),
            },
        };
    }

    /**
     * The project page's answer for `projectPath`. Closed plans and merged PRs
     * only when asked; the plans themselves unless asked without them.
     */
    public async overview(projectPath: string, options: ProjectOverviewOptions = {}): Promise<ProjectOverview> {
        const running = this.deps.running();

        if ((this.deps.agentlessRemote ?? isRemoteProjectPath)(projectPath)) {
            return {
                projectPath,
                remote: true,
                repository: null,
                github: null,
                worktrees: [],
                running: running
                    .filter((session) => session.projectPath === projectPath)
                    .map((session) => session.sessionId),
            };
        }

        const root = await this.deps.git.worktreeRoot(projectPath);
        const origin = root ? await this.deps.remotes.originUrl(root) : null;
        const repository = (origin && gitHubRepository(origin)) || null;

        const [checkouts, github] = await Promise.all([
            root ? this.deps.git.worktrees(root) : Promise.resolve<WorktreeSummary[]>([]),
            root && repository ? this.github(projectPath, root, repository, running, options) : Promise.resolve(null),
        ]);

        const worktrees = sessionsByWorktree(checkouts, running);
        const inProject = (path: string) => isWithin(path, projectPath) || (root !== null && isWithin(path, root));
        const projectRunning = new Set([
            ...worktrees.flatMap((worktree) => worktree.running),
            ...running.filter((session) => inProject(session.projectPath)).map((session) => session.sessionId),
        ]);
        const remote = isRemoteProjectPath(projectPath);
        return {projectPath, remote, repository, github, worktrees, running: [...projectRunning]};
    }

    /**
     * Clean: remove the project's superfluous worktrees, as git lists them now
     * rather than as the page last showed them, one at a time, then prune.
     * What git refuses is answered with its reason; the rest still go.
     */
    public async cleanWorktrees(projectPath: string): Promise<WorktreeCleanResult> {
        const result: WorktreeCleanResult = {removed: [], failed: []};
        if (isRemoteProjectPath(projectPath)) return result;
        const root = await this.deps.git.worktreeRoot(projectPath);
        if (!root) return result;
        const repository = (await this.deps.worktreeWrites.mainCheckout(root)) ?? root;

        const worktrees = sessionsByWorktree(await this.deps.git.worktrees(root), this.deps.running());
        for (const worktree of superfluousWorktrees(worktrees)) {
            const removed = await this.deps.worktreeWrites.removeWorktree(repository, worktree.path);
            if (removed.ok) result.removed.push(worktree.path);
            else result.failed.push({path: worktree.path, reason: removed.reason});
        }
        if (result.removed.length > 0) await this.deps.worktreeWrites.pruneWorktrees(repository);
        return result;
    }

    private async github(
        projectPath: string,
        root: string,
        repository: string,
        running: RunningSession[],
        options: ProjectOverviewOptions,
    ): Promise<ProjectGitHubOverview> {
        const closed = options.closed === true;
        const merged = options.merged === true;
        const withPlans = options.plans !== false;
        // Without plans, Show closed changes nothing: one key for both.
        const key = withPlans
            ? `${repository}:${closed ? 'closed' : 'open'}:${merged ? 'merged' : 'open'}`
            : `${repository}:no-plans:${merged ? 'merged' : 'open'}`;

        const fresh = await this.reads(key, () =>
            withPlans
                ? this.read(projectPath, root, repository, closed, merged)
                : this.readWithoutPlans(root, repository, merged),
        );
        if (fresh) this.last.set(key, fresh);
        const reads = fresh ?? this.last.get(key);
        if (!reads) return {ok: false, reason: await this.unavailable()};

        const owners = await this.deps.owners.issueSessions(repository).catch(() => ({}));
        const sessions = {owners, running: new Set(running.map((session) => session.sessionId))};
        const open = reads.pullRequests.filter((pr) => pr.state === 'open');
        const closedOnes = reads.pullRequests.filter((pr) => pr.state !== 'open');
        const input = {repository, plans: reads.plans, issues: reads.issues, sessions};
        const groups = groupOverview({...input, pullRequests: open});
        // Merged and closed PRs are listed with their issues and plan, but never stand for an open issue's PR.
        if (closedOnes.length > 0)
            groups.pullRequests.push(...groupOverview({...input, pullRequests: closedOnes}).pullRequests);
        return {
            ok: true,
            fetchedAt: reads.fetchedAt,
            stale: fresh === null,
            plansPending: !withPlans,
            mergeQueue: reads.queue ? mergeQueue({...reads.queue, now: this.deps.clock.now()}) : null,
            ...groups,
            // Grouped without plans, an issue with sub-issues stands as an unlevelled plan: not shown until the plans are read.
            plans: withPlans ? groups.plans : [],
        };
    }

    /** Everything `gh` is asked for one answer; null when any of it could not be read. */
    private async read(
        projectPath: string,
        root: string,
        repository: string,
        closed: boolean,
        merged: boolean,
    ): Promise<GitHubReads | null> {
        const {plans, github, clock} = this.deps;
        const fetchedAt = clock.now();
        const [summaries, issues, pullRequests] = await Promise.all([
            plans.projectPlans(projectPath, {closed}),
            github.issuesIn(repository, {closed: false}),
            this.pullRequestsWithQueue(root, repository, merged),
        ]);
        if (!summaries || !issues || !pullRequests) return null;

        const read = await Promise.all(summaries.map((summary) => plans.plan(summary.repository, summary.number)));
        if (read.some((plan) => plan === null)) return null;
        const sources = summaries.map((summary, at): OverviewPlanSource => ({
            plan: read[at] as Plan,
            state: summary.state,
            updatedAt: summary.updatedAt,
        }));

        return {
            fetchedAt,
            plans: sources,
            issues: issues.map((issue) => projectIssue(issue, repository)),
            pullRequests: pullRequests.prs.map((pr) => projectPullRequest(pr, repository)),
            queue: pullRequests.queue,
        };
    }

    /** The issues and PRs alone, for an answer without plans; null when either could not be read. */
    private async readWithoutPlans(root: string, repository: string, merged: boolean): Promise<GitHubReads | null> {
        const {github, clock} = this.deps;
        const fetchedAt = clock.now();
        const [issues, pullRequests] = await Promise.all([
            github.issuesIn(repository, {closed: false}),
            this.pullRequestsWithQueue(root, repository, merged),
        ]);
        if (!issues || !pullRequests) return null;
        return {
            fetchedAt,
            plans: [],
            issues: issues.map((issue) => projectIssue(issue, repository)),
            pullRequests: pullRequests.prs.map((pr) => projectPullRequest(pr, repository)),
            queue: pullRequests.queue,
        };
    }

    /** The PRs, and the merge queue's reads once they are in; null when the PRs could not be read. */
    private async pullRequestsWithQueue(
        root: string,
        repository: string,
        merged: boolean,
    ): Promise<{prs: RepositoryPullRequest[]; queue: QueueReads | null} | null> {
        const prs = await this.deps.github.pullRequestsIn(repository, {merged});
        return prs ? {prs, queue: await this.queueReads(root, repository, prs)} : null;
    }

    /**
     * The merge queue's reads, from the open PRs: null when none of them shows
     * the queue, and otherwise the trunk and the CI run durations besides.
     *
     * Only the open PRs `pullRequestsIn` read count: the 50 most recently
     * updated (PULL_REQUESTS_PER_REPOSITORY). In a repository with more open
     * PRs than that, a queued PR nobody has touched for a while is not seen:
     * the queue shows without it, and a stack whose lower member was cut off
     * starts at the lowest member that was read. The queue itself still works
     * on every PR; only what the page shows is cut off.
     */
    private async queueReads(
        root: string,
        repository: string,
        pullRequests: RepositoryPullRequest[],
    ): Promise<QueueReads | null> {
        const open = pullRequests.filter((pr) => pr.state === 'open').map(queuePullRequest);
        if (!usesMergeQueue(open)) return null;
        const [trunk, durations] = await Promise.all([
            this.deps.git.defaultBranch(root),
            this.deps.github.ciRunDurations(repository).catch(() => null),
        ]);
        return {trunk, pullRequests: open, ciRunDurationsMs: durations ?? []};
    }

    /** Why `gh` could not answer: it is missing, signed out, or GitHub was not reached. */
    private async unavailable(): Promise<GitHubUnavailableReason> {
        const availability = await this.deps.github.available().catch(() => 'ok' as const);
        return availability === 'missing' ? 'no-gh' : availability === 'unauthenticated' ? 'signed-out' : 'unreachable';
    }

    /** The reads kept under `key` while they are fresh, or a new read. */
    private reads(key: string, read: () => Promise<GitHubReads | null>): Promise<GitHubReads | null> {
        const now = this.deps.clock.now();
        const hit = this.fresh.get(key);
        if (hit && now - hit.at < PLAN_CACHE_MS) return hit.reads;

        const entry = {at: now, reads: read().catch(() => null)};
        this.fresh.set(key, entry);
        void entry.reads.then((reads) => {
            if (reads === null && this.fresh.get(key) === entry) this.fresh.delete(key);
        });
        for (const [other, cached] of this.fresh) {
            if (now - cached.at >= PLAN_CACHE_MS) this.fresh.delete(other);
        }
        return entry.reads;
    }
}

/**
 * `read`, with one call in flight per set of arguments: a second ask while
 * the first is out gets the same promise. Nothing is kept once it settles.
 */
function inFlightShared<A extends unknown[], R>(read: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    const pending = new Map<string, Promise<R>>();
    return (...args) => {
        const key = JSON.stringify(args);
        const out = pending.get(key);
        if (out) return out;
        const call = read(...args).finally(() => pending.delete(key));
        pending.set(key, call);
        return call;
    };
}

function projectIssue(issue: RepositoryIssue, repository: string): ProjectIssue {
    const {parent, subIssues, ...rest} = issue;
    return {
        ...rest,
        parent: parent && parent.repository === repository ? parent.number : null,
        subIssueCount: subIssues,
    };
}

function projectPullRequest(pr: RepositoryPullRequest, repository: string): ProjectPullRequest {
    const {queue: _queue, ...rest} = pr;
    return {
        ...rest,
        closes: pr.closes.filter((issue) => issue.repository === repository).map((issue) => issue.number),
    };
}

function queuePullRequest(pr: RepositoryPullRequest): QueuePullRequest {
    const {number, title, headRef, draft, review} = pr;
    return {number, title, headRef, draft, review, ...pr.queue};
}

/**
 * Each checkout with the sessions running in it. A session in a linked
 * worktree under the main checkout (`.claude/worktrees/…`) belongs to that
 * worktree, not to the main one: the deepest checkout that holds it wins.
 */
function sessionsByWorktree(checkouts: WorktreeSummary[], running: RunningSession[]): WorktreeOverview[] {
    const byPath = new Map<string, string[]>(checkouts.map((checkout) => [checkout.path, []]));
    for (const session of running) {
        const holder = checkouts
            .filter((checkout) => isWithin(session.projectPath, checkout.path))
            .sort((a, b) => b.path.length - a.path.length)[0];
        if (holder) byPath.get(holder.path)!.push(session.sessionId);
    }
    return checkouts.map((checkout) => ({...checkout, running: byPath.get(checkout.path)!}));
}

/** `path` is `dir` or a directory under it. */
function isWithin(path: string, dir: string): boolean {
    const base = dir.replace(/\/+$/, '');
    return path === base || path.startsWith(base + '/');
}
