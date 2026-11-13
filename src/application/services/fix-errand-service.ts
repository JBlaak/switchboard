/**
 * Fix errands (#437, for #432): the Merge manager's sessions that start, run
 * and finish by themselves when a lane's head fails out on a conflict or a
 * failed check. The rules are `domain/merge-manager/errands`; this is their
 * plumbing.
 *
 * - **Start.** Each lane read the Merge manager folds in (`laneRead`) is
 *   looked over for landed PRs at Fixing (`errandWanted`). Each gets a new
 *   session in a worktree of its own under the repository's local checkout,
 *   detached at `origin/<branch>`, in auto mode with allow rules scoped to the
 *   branch, on a prompt naming the failure, the failing checks' log tails,
 *   the old base tip of a stack and what earlier errands said. The errand is
 *   linked to its PR (`linkErrand`). One that cannot start (no local
 *   checkout, a fetch that fails) leaves the PR Needs you.
 * - **Finish.** `finish_errand` (`finish`) records the outcome and asks for
 *   the session's archive. `pushed`: the PR's head commit must have moved,
 *   and its set-aside is cleared so it goes back to its place; a head that
 *   did not move is Needs you. `retry`: the failed Actions runs are run again
 *   (Switchboard lane) or `automerge:failed` comes off (queue lane), and the
 *   set-aside is cleared. A conflict, or a check failure with no run to run
 *   again, has nothing to retry: Needs you.
 * - **Stopped.** A turn that ends without `finish_errand`, a session that
 *   asks for attention (a permission prompt) or one that ends: the PR is
 *   Needs you on the commit it failed on. A later `finish_errand`, any new
 *   commit or Try again (`tryAgain`) clears it; archiving the errand by hand
 *   does not.
 *
 * Errands for a PR that left its lane are forgotten.
 */
import {
    actionsRunId,
    earlierErrands,
    errandAllowRules,
    errandPrompt,
    errandWanted,
    fixErrandState,
    isErrandBranch,
    isErrandSession,
    parseFinishInput,
    type ErrandOutcome,
    type FailingCheck,
    type FixErrand,
} from '../../domain/merge-manager/errands';
import {QUEUE_LABELS} from '../../domain/project/merge-queue';
import type {
    FixingCause,
    LandedPullRequest,
    LaneKind,
    LanePullRequestRead,
    SetAside,
} from '../../domain/merge-manager/model';
import type {ArchiveToolOutcome} from '../../domain/session/archive-tool';
import type {SessionOptions} from '../../domain/launch/session-options';
import type {Clock} from '../ports/clock';
import type {FixErrandStore} from '../ports/fix-errand-store';
import type {GitWorktrees} from '../ports/git-workspace';
import type {GitHubCli, GitHubWrite} from '../ports/github-cli';
import type {IdGenerator} from '../ports/ids';
import type {Logger} from '../ports/logger';
import type {FoldedLane, MergeManagerService} from './merge-manager-service';
import {WORKTREES_DIR} from './support/branch-worktrees';

/** How much of a failing check's log the prompt carries. */
export const ERRAND_LOG_TAIL_LINES = 80;

/** How many failing checks' logs the prompt carries. */
export const ERRAND_LOGS = 3;

/**
 * After a `retry`, how long the PR may still read as failed on the same
 * commit before it counts as failing again: the runs take a moment to show
 * as queued.
 */
export const RETRY_SETTLE_MS = 10 * 60_000;

export interface FixErrandServiceDeps {
    store: FixErrandStore;
    manager: Pick<MergeManagerService, 'pullRequest' | 'setAside' | 'linkErrand' | 'poll'>;
    github: Pick<GitHubCli, 'laneRead' | 'pullRequests' | 'checkLogTail' | 'rerunFailedJobs' | 'removeLabel'>;
    /** The local main checkout of a GitHub repository (`owner/repo`), or null when there is none. */
    checkoutOf(repository: string): Promise<string | null>;
    git: Pick<GitWorktrees, 'fetchBranch' | 'addDetachedWorktree'>;
    /** Start an errand's session in its worktree, with these options, and give it a row. */
    sessions: {
        start(request: {sessionId: string; worktree: string; options: SessionOptions}): Promise<StartOutcome>;
    };
    /** Ask for the session's archive at the end of its turn (`archive_session`'s request). */
    archive: {request(launchId: string): ArchiveToolOutcome};
    ids: IdGenerator;
    clock: Clock;
    log: Logger;
}

export type StartOutcome = {ok: true} | {ok: false; reason: string};

/** Try again's answer: the errand's session, or why none started. */
export type TryAgainResult = {ok: true; sessionId: string} | {ok: false; reason: string};

export class FixErrandService {
    /** PRs whose errand is being started, so a second read does not start another. */
    private readonly starting = new Set<string>();
    /** PRs just retried, by key: the commit, and until when a failure on it is the old one still showing. */
    private readonly settling = new Map<string, {headOid: string; until: number}>();

    constructor(private readonly deps: FixErrandServiceDeps) {}

    /** Every errand, oldest first. */
    public errands(): FixErrand[] {
        return this.deps.store.all();
    }

    /** Is this session a fix errand's? Only those are offered `finish_errand`. */
    public isErrand(sessionId: string): boolean {
        return this.errands().some((errand) => isErrandSession(errand, sessionId));
    }

    // ── Start ──

    /** A lane read was folded in: start the errands it wants, and forget those of PRs that left. */
    public laneRead(lane: FoldedLane): void {
        const repository = lane.repository.toLowerCase();
        const keys = new Set(lane.landed.map((pr) => pr.key));
        const gone = this.errands()
            .filter((errand) => errand.repository.toLowerCase() === repository && !keys.has(errand.key))
            .map((errand) => errand.id);
        if (gone.length) this.deps.store.remove(gone);

        const reads = new Map(lane.read.pullRequests.map((read) => [read.number, read]));
        for (const pr of lane.landed) {
            const read = reads.get(pr.number) ?? null;
            if (!read || this.starting.has(pr.key)) continue;
            if (this.stillSettling(pr, read)) continue;
            const wanted = errandWanted(pr, read, this.errands());
            if (!wanted) continue;
            void this.start(pr, read, lane.read.trunk, wanted.cause, null);
        }
    }

    /** Try again: a new errand for a PR an errand gave up on (or that is failing with none), with an optional note. */
    public async tryAgain(repository: string, number: number, note: string | null): Promise<TryAgainResult> {
        const pr = this.deps.manager.pullRequest(repository, number);
        if (!pr) return {ok: false, reason: `#${number} is not landed`};
        if (this.starting.has(pr.key)) return {ok: false, reason: `#${number}'s errand is already starting`};
        const lane = await this.deps.github.laneRead(pr.repository, [number]).catch(() => null);
        const read = lane?.pullRequests.find((candidate) => candidate.number === number) ?? null;
        if (!lane || !read) return {ok: false, reason: `#${number} could not be read from GitHub`};
        const wanted = errandWanted(pr, read, this.errands(), {force: true});
        if (!wanted) {
            const running = this.errands().some((e) => e.key === pr.key && fixErrandState(e) === 'running');
            return {ok: false, reason: running ? `#${number} has an errand running` : `#${number} has nothing to fix`};
        }
        return this.start(pr, read, lane.trunk, wanted.cause, note?.trim() || null);
    }

    private async start(
        pr: LandedPullRequest,
        read: LanePullRequestRead,
        trunk: string,
        cause: FixingCause,
        userNote: string | null,
    ): Promise<TryAgainResult> {
        this.starting.add(pr.key);
        try {
            return await this.launch(pr, read, trunk, cause, userNote);
        } catch (err) {
            return this.couldNotStart(pr, read, cause, (err as Error).message || 'it failed');
        } finally {
            this.starting.delete(pr.key);
        }
    }

    private async launch(
        pr: LandedPullRequest,
        read: LanePullRequestRead,
        trunk: string,
        cause: FixingCause,
        userNote: string | null,
    ): Promise<TryAgainResult> {
        const {git, ids, clock, log} = this.deps;
        const branch = read.headRef;
        if (!isErrandBranch(branch))
            return this.couldNotStart(pr, read, cause, `"${branch}" is not a branch it can push`);
        const root = await this.deps.checkoutOf(pr.repository);
        if (!root) return this.couldNotStart(pr, read, cause, `there is no local checkout of ${pr.repository}`);
        const fetched = await git.fetchBranch(root, branch);
        if (!fetched.ok)
            return this.couldNotStart(pr, read, cause, `${branch} could not be fetched: ${fetched.reason}`);

        const id = ids.newId();
        const sessionId = ids.newId();
        const worktree = `${root.replace(/\/+$/, '')}${WORKTREES_DIR}errand-${pr.number}-${id.slice(0, 8)}`;
        const added = await git.addDetachedWorktree(root, worktree, `origin/${branch}`);
        if (!added.ok) return this.couldNotStart(pr, read, cause, `its worktree could not be made: ${added.reason}`);

        const failing = cause === 'checks' ? await this.failingChecks(pr.repository, pr.number) : [];
        const prompt = errandPrompt({
            repository: pr.repository,
            number: pr.number,
            title: read.title,
            url: read.url,
            branch,
            trunk,
            lane: pr.lane,
            cause,
            headOid: read.headOid,
            worktree,
            failingChecks: failing,
            queueReason: pr.lane === 'queue' ? (read.automerge?.description ?? null) : null,
            oldBaseTip: cause === 'conflict' && read.baseRef === trunk ? (pr.stackBaseTip ?? null) : null,
            earlier: earlierErrands(this.errands(), pr.key),
            userNote,
        });
        const errand: FixErrand = {
            id,
            key: pr.key,
            repository: pr.repository,
            number: pr.number,
            branch,
            lane: pr.lane,
            cause,
            headOid: read.headOid,
            sessionId,
            currentId: sessionId,
            worktree,
            startedAt: clock.now(),
            finished: null,
            stoppedAt: null,
        };
        // Kept before the session starts, so its first calls already find it.
        this.deps.store.save(errand);
        const started = await this.deps.sessions.start({
            sessionId,
            worktree,
            options: {permissionMode: 'auto', initialPrompt: prompt, allowedTools: errandAllowRules(branch)},
        });
        if (!started.ok) {
            this.deps.store.save({...errand, stoppedAt: clock.now()});
            return this.couldNotStart(pr, read, cause, started.reason);
        }

        this.deps.manager.linkErrand(pr.key, sessionId);
        // Fixing on its commit, in either lane, whatever set it aside before (an errand that stopped).
        if (pr.lane === 'switchboard') this.deps.manager.setAside(pr.key, fixing(cause, read.headOid));
        else if (pr.setAside) this.deps.manager.setAside(pr.key, null);
        log.info(`[fix-errands] ${pr.key} (${cause}) errand started as session=${sessionId} in ${worktree}`);
        return {ok: true, sessionId};
    }

    /** No errand could start: the PR needs you on the commit it failed on. */
    private couldNotStart(
        pr: LandedPullRequest,
        read: LanePullRequestRead,
        cause: FixingCause,
        why: string,
    ): TryAgainResult {
        this.deps.log.warn(`[fix-errands] ${pr.key}: no errand started, ${why}`);
        this.deps.manager.setAside(pr.key, stopped(cause, read.headOid));
        return {ok: false, reason: `No fix errand started: ${why}`};
    }

    /** The failing checks with their log tails, and the Actions runs behind them. */
    private async failingChecks(
        repository: string,
        number: number,
    ): Promise<Array<FailingCheck & {runId: number | null}>> {
        const answer = await this.deps.github.pullRequests(repository, [number]).catch(() => null);
        const status = answer?.find((candidate) => candidate.number === number);
        const failing = (status?.checks ?? []).filter((check) => check.state === 'failing');
        const checks: Array<FailingCheck & {runId: number | null}> = [];
        for (const [index, check] of failing.entries()) {
            const logTail =
                index < ERRAND_LOGS && check.url
                    ? await this.deps.github
                          .checkLogTail(repository, check.url, ERRAND_LOG_TAIL_LINES)
                          .catch(() => null)
                    : null;
            checks.push({name: check.name, logTail, runId: actionsRunId(check.url)});
        }
        return checks;
    }

    /** A retried PR still reading as failed on the same commit, while its runs come back as queued. */
    private stillSettling(pr: LandedPullRequest, read: LanePullRequestRead): boolean {
        const settling = this.settling.get(pr.key);
        if (!settling) return false;
        if (pr.stage.kind === 'fixing' && settling.headOid === read.headOid && this.deps.clock.now() < settling.until) {
            return true;
        }
        this.settling.delete(pr.key);
        return false;
    }

    // ── Finish ──

    /** `finish_errand` from the session launched as `launchId`. */
    public finish(launchId: string, args: unknown): ArchiveToolOutcome {
        const errand = this.errands().find((candidate) => isErrandSession(candidate, launchId));
        if (!errand) return {ok: false, message: 'This session is not a fix errand, so nothing was recorded.'};
        const input = parseFinishInput(args);
        if (!input.ok) return {ok: false, message: input.message};

        const at = this.deps.clock.now();
        this.deps.store.save({...errand, finished: {outcome: input.outcome, note: input.note, at}, stoppedAt: null});
        this.deps.log.info(`[fix-errands] ${errand.key} errand finished: ${input.outcome}`);
        void this.settle(errand, input.outcome).catch((err) =>
            this.deps.log.error(
                `[fix-errands] ${errand.key}: settling ${input.outcome} failed:`,
                (err as Error).message,
            ),
        );
        const archive = this.deps.archive.request(launchId);
        return {
            ok: true,
            message:
                `Recorded: ${input.outcome}. ` +
                (archive.ok ? archive.message : 'This session could not be archived; it stays as it is.'),
        };
    }

    /** What the Merge manager does with an errand's outcome. */
    private async settle(errand: FixErrand, outcome: ErrandOutcome): Promise<void> {
        const {manager} = this.deps;
        const pr = manager.pullRequest(errand.repository, errand.number);
        if (!pr) return;
        if (outcome === 'pushed') {
            const lane = await this.deps.github.laneRead(errand.repository, [errand.number]).catch(() => null);
            const read = lane?.pullRequests.find((candidate) => candidate.number === errand.number);
            if (!read) {
                this.deps.log.warn(`[fix-errands] ${errand.key}: could not read whether its head moved`);
                return;
            }
            if (read.headOid === errand.headOid) {
                this.deps.log.warn(`[fix-errands] ${errand.key}: said pushed, but its head did not move`);
                manager.setAside(errand.key, stopped(errand.cause, errand.headOid));
            } else {
                manager.setAside(errand.key, null);
            }
        } else {
            const retried = await this.retry(errand, pr.lane);
            if (!retried.ok) {
                this.deps.log.warn(`[fix-errands] ${errand.key}: retry not possible, ${retried.reason}`);
                manager.setAside(errand.key, stopped(errand.cause, errand.headOid));
                return;
            }
            this.settling.set(errand.key, {headOid: errand.headOid, until: this.deps.clock.now() + RETRY_SETTLE_MS});
            manager.setAside(errand.key, null);
        }
        void manager.poll();
    }

    /** Run the failure again: its failed runs (Switchboard lane), or the queue's failed label off (queue lane). */
    private async retry(errand: FixErrand, lane: LaneKind): Promise<GitHubWrite> {
        if (lane === 'queue') {
            const removed = await this.deps.github.removeLabel(errand.repository, errand.number, QUEUE_LABELS.failed);
            return !removed.ok && /label does not exist/i.test(removed.reason) ? {ok: true} : removed;
        }
        if (errand.cause === 'conflict') return {ok: false, reason: 'a conflict has nothing to run again'};
        const runs = new Set(
            (await this.failingChecks(errand.repository, errand.number))
                .map((check) => check.runId)
                .filter((runId): runId is number => runId !== null),
        );
        if (runs.size === 0) return {ok: false, reason: 'no failed Actions run to run again'};
        let rerun = 0;
        for (const runId of runs) {
            const written = await this.deps.github.rerunFailedJobs(errand.repository, runId);
            if (written.ok) rerun++;
            else this.deps.log.warn(`[fix-errands] ${errand.key}: run ${runId} not re-run:`, written.reason);
        }
        return rerun > 0 ? {ok: true} : {ok: false, reason: 'no failed run could be run again'};
    }

    // ── Stopped ──

    /**
     * A turn of a running session ended, under any of the ids it has gone by:
     * an errand's that did not finish stopped. `currentId` is kept.
     */
    public turnEnded(sessionIds: readonly string[], _archiving: boolean, currentId?: string): void {
        for (const errand of this.errands()) {
            if (!sessionIds.some((id) => isErrandSession(errand, id))) continue;
            let kept = errand;
            if (currentId && currentId !== errand.currentId) {
                kept = {...errand, currentId};
                this.deps.store.save(kept);
                this.deps.manager.linkErrand(errand.key, currentId);
            }
            if (fixErrandState(kept) === 'running') this.stop(kept, 'its turn ended without finish_errand');
        }
    }

    /** A session is blocked on the user (a permission prompt, a question). */
    public needsAttention(sessionId: string): void {
        for (const errand of this.errands()) {
            if (isErrandSession(errand, sessionId) && fixErrandState(errand) === 'running') {
                this.stop(errand, 'it is waiting for you');
            }
        }
    }

    /** A session ended. */
    public sessionEnded(sessionId: string): void {
        for (const errand of this.errands()) {
            if (isErrandSession(errand, sessionId) && fixErrandState(errand) === 'running') {
                this.stop(errand, 'its session ended without finish_errand');
            }
        }
    }

    private stop(errand: FixErrand, why: string): void {
        this.deps.store.save({...errand, stoppedAt: this.deps.clock.now()});
        this.deps.log.info(`[fix-errands] ${errand.key} errand stopped: ${why}`);
        this.deps.manager.setAside(errand.key, stopped(errand.cause, errand.headOid));
    }
}

function fixing(cause: FixingCause, headOid: string): SetAside {
    return {kind: 'fixing', cause, reason: null, headOid};
}

function stopped(cause: FixingCause, headOid: string): SetAside {
    return {kind: 'needsYou', cause, reason: {kind: 'errand-stopped'}, headOid};
}
