/**
 * The merge queue's buttons (#315): Nudge, Fix in session, Retry and Opt in.
 *
 * Switchboard never moves a PR itself. Retry and Opt in write the queue's own
 * labels, and only these two: `automerge:failed` removed, `automerge:opt-in`
 * added. Nudge and Fix in session run their job in a Claude session:
 *
 * - **Nudge** answers the first prompt of a session that finds the reviewer
 *   on Slack, sends the message the user confirmed, and archives itself. A
 *   nudge stands for its review request: a second one for the same PR and
 *   reviewer is refused until `forgetNudge` or `settleNudges` says the
 *   request changed.
 * - **Fix in session** hands the queue's failure to the running session that
 *   owns the PR (the one whose transcript linked it, as the CI watch decides)
 *   as a queued action, which is never told to archive; with no such session
 *   it makes a worktree on the PR's branch and answers the first prompt of a
 *   new session there, which pushes the fix and archives itself.
 *
 * The renderer starts every new session, because a session's row is its to
 * make, then says which session it started (`started`), or that it could not
 * (`abandon`). Those sessions are errands, kept in a store so they stay
 * errands across a restart, and `errands` says how far each got: an errand
 * "needs you" once a turn of it ends without it having asked to be archived,
 * and it is at its prompt (or it ended without being archived).
 */
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {QUEUE_LABELS} from '../../domain/project/merge-queue';
import {
    errandState,
    fixAction,
    fixPrompt,
    nudgeMessage,
    nudgePrompt,
    type ErrandPullRequest,
    type ErrandResult,
    type FixRequest,
    type FixResult,
    type NudgeRequest,
    type NudgeResult,
    type QueueErrand,
    type QueueErrandView,
    type QueueFailure,
} from '../../domain/project/queue-errands';
import type {PullRequestStatus} from '../../domain/session-work/model';
import type {SessionPullRequest} from '../../domain/session/session';
import type {Clock} from '../ports/clock';
import type {GitWorkspace} from '../ports/git-workspace';
import type {GitHubCli, GitHubWrite} from '../ports/github-cli';
import type {IdGenerator} from '../ports/ids';
import type {Logger} from '../ports/logger';
import type {QueueErrandStore} from '../ports/queue-errand-store';
import type {SessionPrompter} from '../ports/session-prompter';
import type {AwaitableTranscriptStore} from '../ports/transcript-queries';
import {AUTO_FIX_LOG_TAIL_LINES, type SessionActionService} from './session-action-service';
import {BranchWorktrees, type BranchSessionCandidate, type BranchWorktreesDeps} from './support/branch-worktrees';

/** An errand whose session the renderer never said it started is given up on after this long. */
export const ERRAND_START_TIMEOUT_MS = 10 * 60_000;

/** Errands are forgotten this long after they were asked for. */
export const ERRAND_RETENTION_MS = 14 * 24 * 60 * 60_000;

/**
 * The two label writes the buttons make. `GitHubCli` gains them (`addLabel`,
 * `removeLabel`); this is the slice of it the service needs.
 */
export interface QueueLabelWriter {
    addLabel(repo: string, number: number, label: string): Promise<GitHubWrite>;
    removeLabel(repo: string, number: number, label: string): Promise<GitHubWrite>;
}

/** A running Claude session that may own a PR: the CI watch's view of it. */
export interface ErrandOwnerCandidate {
    sessionId: string;
    projectPath: string;
    /** Its transcript folder; null when it has none yet. */
    folder: string | null;
    /** The PRs its transcript linked. */
    pullRequests: readonly SessionPullRequest[];
}

export interface QueueErrandServiceDeps {
    /** The running Claude sessions that may own a PR (the CI watch's). */
    running(): ErrandOwnerCandidate[];
    /** Every listed and running session, for the worktree mechanics (as issue starts use). */
    sessions(): BranchSessionCandidate[];
    store: QueueErrandStore;
    actions: Pick<SessionActionService, 'queuePrompt'>;
    github: Pick<GitHubCli, 'pullRequests' | 'checkLogTail'>;
    labels: QueueLabelWriter;
    git: BranchWorktreesDeps['git'] & Pick<GitWorkspace, 'worktreeRoot'>;
    transcripts: Pick<AwaitableTranscriptStore, 'locations'>;
    prompter: Pick<SessionPrompter, 'runningId' | 'isBusy'>;
    /** Has the running session called `archive_session`? */
    archiveRequested(sessionId: string): boolean;
    /** Is the session archived in the sidebar? */
    archived(sessionId: string): boolean;
    ids: IdGenerator;
    clock: Clock;
    log: Logger;
    /** Whether a path is on a remote with no Switchboard agent (see BranchWorktreesDeps). */
    agentlessRemote?: (path: string) => boolean;
}

export class QueueErrandService {
    private readonly worktrees: BranchWorktrees;
    /** Errands (by id) a turn of which ended without asking to be archived. */
    private readonly stopped = new Set<string>();

    constructor(private readonly deps: QueueErrandServiceDeps) {
        this.worktrees = new BranchWorktrees(deps);
        const now = deps.clock.now();
        for (const errand of deps.store.all()) {
            if (now - errand.createdAt > ERRAND_RETENTION_MS) deps.store.remove(errand.id);
        }
    }

    // ── Retry and Opt in: the only labels ever written ──

    /**
     * Retry: take `automerge:failed` off, so the queue takes the PR back. A
     * label that is already gone (the queue took it off itself) is not a failure.
     */
    public async retry(repository: string, number: number): Promise<GitHubWrite> {
        const written = await this.deps.labels.removeLabel(repository, number, QUEUE_LABELS.failed);
        if (!written.ok && /label does not exist/i.test(written.reason)) return {ok: true};
        return written;
    }

    /** Opt in: put `automerge:opt-in` on, so the queue takes the PR. */
    public optIn(repository: string, number: number): Promise<GitHubWrite> {
        return this.deps.labels.addLabel(repository, number, QUEUE_LABELS.optIn);
    }

    // ── Nudge ──

    /** Remember the nudge and answer its session's first prompt; refused while one for the request stands. */
    public nudge({repository, pr, reviewer, message}: NudgeRequest): NudgeResult {
        if (message !== nudgeMessage(pr, reviewer)) {
            return {ok: false, reason: 'That is not the message Switchboard would send; nothing was sent'};
        }
        const standing = this.liveErrands().find(
            (errand) =>
                errand.kind === 'nudge' &&
                errand.settledAt === null &&
                errand.repository === repository &&
                errand.number === pr.number &&
                errand.reviewer === reviewer,
        );
        if (standing) return {ok: false, reason: `${reviewer} was already nudged about #${pr.number}`};

        const errand = this.add('nudge', repository, pr, {reviewer, message});
        this.deps.log.info(`[queue-errands] nudging ${reviewer} about ${repository}#${pr.number}`);
        return {ok: true, errandId: errand.id, prompt: nudgePrompt(reviewer, message)};
    }

    /** The review request changed: a nudge for it may go again. */
    public forgetNudge(repository: string, number: number, reviewer: string): void {
        const at = this.deps.clock.now();
        for (const errand of this.deps.store.all()) {
            if (
                errand.kind === 'nudge' &&
                errand.settledAt === null &&
                errand.repository === repository &&
                errand.number === number &&
                errand.reviewer === reviewer
            ) {
                this.deps.store.settle(errand.id, at);
            }
        }
    }

    /**
     * The queue as it stands: these PRs of the repository wait for these
     * reviewers. Every other standing nudge in it is forgotten, its request
     * having changed. Safe to call on every read of the queue.
     */
    public settleNudges(repository: string, held: readonly {number: number; reviewer: string}[]): void {
        for (const errand of this.deps.store.all()) {
            if (errand.kind !== 'nudge' || errand.settledAt !== null || errand.repository !== repository) continue;
            if (held.some((entry) => entry.number === errand.number && entry.reviewer === errand.reviewer)) continue;
            this.deps.store.settle(errand.id, this.deps.clock.now());
        }
    }

    // ── Fix in session ──

    /** Hand the queue's failure to the PR's own running session, or prepare a new one on its branch. */
    public async fix({repository, projectPath, pr, failure}: FixRequest): Promise<FixResult> {
        const status = await this.status(repository, pr.number);
        const logTail = failure.kind === 'ci' ? await this.logTail(repository, failure, status) : null;
        const facts = {
            kind: failure.kind,
            reason: failure.reason,
            checkName: failure.checkName,
            sha: status?.headSha ?? null,
            logTail,
            threads: status?.threads ?? [],
        };
        const headRef = pr.headRef || status?.headRef || '';
        if (!headRef) return {ok: false, reason: `Could not tell which branch #${pr.number} is on`};
        const prompted = {number: pr.number, url: pr.url, headRef, baseRef: pr.baseRef || status?.baseRef || 'main'};

        const owner = this.owner(repository, pr);
        if (owner) {
            const worktree = await this.ownerWorktree(owner, headRef);
            const result = this.deps.actions.queuePrompt(owner.sessionId, {
                itemKey: 'pr:' + pr.url,
                action: fixAction(failure.kind),
                repository,
                prompt: fixPrompt({pr: prompted, failure: facts, worktree, errand: false}),
                details: failure.kind === 'ci' && failure.checkName ? {checkName: failure.checkName} : null,
            });
            if (!result.ok) return result;
            this.deps.log.info(`[queue-errands] fix for ${repository}#${pr.number} queued in ${owner.sessionId}`);
            return {ok: true, kind: 'queued', sessionId: owner.sessionId, activityId: result.activityId};
        }

        const busy = this.views().find(
            (errand) =>
                errand.kind === 'fix' &&
                errand.repository === repository &&
                errand.number === pr.number &&
                errand.state !== 'done',
        );
        if (busy) {
            return {
                ok: false,
                reason:
                    busy.state === 'needs-you'
                        ? `The fix session for #${pr.number} is waiting for you`
                        : `A fix session for #${pr.number} is already running`,
            };
        }

        const prepared = await this.prepareWorktree(projectPath, headRef);
        if (!prepared.ok) return prepared;
        const errand = this.add('fix', repository, pr, {reviewer: null, message: null});
        this.deps.log.info(`[queue-errands] fix for ${repository}#${pr.number} prepared in ${prepared.worktreePath}`);
        return {
            ok: true,
            kind: 'start',
            errandId: errand.id,
            worktreePath: prepared.worktreePath,
            branch: headRef,
            prompt: fixPrompt({pr: prompted, failure: facts, worktree: prepared.worktreePath, errand: true}),
            ...(prepared.warning ? {warning: prepared.warning} : {}),
        };
    }

    /** The running session whose transcript linked the PR, if any. */
    private owner(repository: string, pr: ErrandPullRequest): ErrandOwnerCandidate | null {
        return (
            this.deps
                .running()
                .find((session) =>
                    session.pullRequests.some(
                        (link) =>
                            link.url === pr.url ||
                            (link.number === pr.number && (link.repository || repositoryOf(link.url)) === repository),
                    ),
                ) ?? null
        );
    }

    /** Where the owner worked on the branch, from its transcript; else the worktree it was started in. */
    private async ownerWorktree(owner: ErrandOwnerCandidate, headRef: string): Promise<string> {
        const {git, transcripts} = this.deps;
        if (owner.folder) {
            const written = (await transcripts.locations(owner.folder, owner.sessionId)).find(
                (location) => location.branch === headRef,
            );
            if (written) return (await git.worktreeRoot(written.cwd)) ?? written.cwd;
        }
        return (await git.worktreeRoot(owner.projectPath)) ?? owner.projectPath;
    }

    /** A worktree on the PR's existing branch: its own when it has one, else a new one off `origin/<branch>`. */
    private async prepareWorktree(
        projectPath: string,
        branch: string,
    ): Promise<{ok: true; worktreePath: string; warning?: string} | {ok: false; reason: string}> {
        const {git} = this.deps;
        if ((this.deps.agentlessRemote ?? isRemoteProjectPath)(projectPath)) {
            return {ok: false, reason: 'A fix session can only start in a local project or on a VM'};
        }
        const root = await git.mainCheckout(projectPath);
        if (!root) return {ok: false, reason: 'Not a git repository: ' + projectPath};
        const fetched = await git.fetchBranch(root, branch);
        const remote = 'origin/' + branch;
        const onOrigin = (await git.commitSha(root, remote)) !== null;
        if (!onOrigin && !(await git.branchExists(root, branch))) {
            return {ok: false, reason: `Could not fetch ${branch}` + (fetched.ok ? '' : `: ${fetched.reason}`)};
        }
        const made = await this.worktrees.prepare({
            root,
            branch,
            existing: 'reuse',
            base: async () => ({base: remote, warnings: []}),
        });
        if (!made.ok) return made;
        const warnings = [...made.warnings];
        if (!fetched.ok)
            warnings.push(`Could not fetch ${branch} (${fetched.reason}); the fix starts from what is here.`);
        return {
            ok: true,
            worktreePath: made.worktreePath,
            ...(warnings.length ? {warning: warnings.join(' ')} : {}),
        };
    }

    private async status(repository: string, number: number): Promise<PullRequestStatus | null> {
        const answer = await this.deps.github.pullRequests(repository, [number]);
        return answer?.find((status) => status.number === number) ?? null;
    }

    /** The failing check's log tail: the run the renderer named, else the failing check `gh` lists by that name. */
    private async logTail(
        repository: string,
        failure: QueueFailure,
        status: PullRequestStatus | null,
    ): Promise<string | null> {
        const failing = (status?.checks ?? []).filter((check) => check.state === 'failing');
        const url =
            failure.checkRunUrl ||
            (failure.checkName ? failing.find((check) => check.name === failure.checkName)?.url : failing[0]?.url);
        if (!url) return null;
        return this.deps.github.checkLogTail(repository, url, AUTO_FIX_LOG_TAIL_LINES);
    }

    // ── Errands ──

    /** The renderer started the errand's session. */
    public started(errandId: string, sessionId: string): ErrandResult {
        const errand = this.deps.store.all().find((candidate) => candidate.id === errandId);
        if (!errand) return {ok: false, reason: 'No errand goes by that id'};
        this.deps.store.setSession(errandId, sessionId);
        return {ok: true};
    }

    /** The renderer could not start the errand's session: forget it, so a nudge may be asked for again. */
    public abandon(errandId: string): ErrandResult {
        const errand = this.deps.store.all().find((candidate) => candidate.id === errandId);
        if (!errand) return {ok: false, reason: 'No errand goes by that id'};
        if (errand.sessionId) return {ok: false, reason: 'Its session has started'};
        this.deps.store.remove(errandId);
        return {ok: true};
    }

    /**
     * A turn of a running session ended (the Stop hook), under any of the ids
     * it has gone by: an errand that did not ask to be archived needs you.
     */
    public turnEnded(sessionIds: readonly string[], archiving: boolean): void {
        for (const errand of this.deps.store.all()) {
            if (!errand.sessionId || !sessionIds.includes(errand.sessionId)) continue;
            if (archiving) this.stopped.delete(errand.id);
            else this.stopped.add(errand.id);
        }
    }

    /** Every errand of the repository (all of them without one), oldest first, with how far it got. */
    public errands(repository?: string): QueueErrandView[] {
        const views = this.views();
        return repository === undefined ? views : views.filter((errand) => errand.repository === repository);
    }

    private views(): QueueErrandView[] {
        const {prompter} = this.deps;
        return this.liveErrands().map((errand) => {
            const stored = errand.sessionId;
            const current = stored ? (prompter.runningId(stored) ?? stored) : null;
            const running = stored !== null && prompter.runningId(stored) !== null;
            const state = errandState({
                started: stored !== null,
                archived: stored !== null && (this.deps.archived(stored) || this.deps.archived(current ?? stored)),
                running,
                busy: running && prompter.isBusy(stored),
                archiveRequested: running && this.deps.archiveRequested(stored),
                stoppedWithoutArchive: this.stopped.has(errand.id),
            });
            return {...errand, sessionId: current, state};
        });
    }

    /** The stored errands, without the ones whose session the renderer never started in time. */
    private liveErrands(): QueueErrand[] {
        const now = this.deps.clock.now();
        return this.deps.store.all().filter((errand) => {
            if (errand.sessionId !== null || now - errand.createdAt <= ERRAND_START_TIMEOUT_MS) return true;
            this.deps.store.remove(errand.id);
            return false;
        });
    }

    private add(
        kind: QueueErrand['kind'],
        repository: string,
        pr: ErrandPullRequest,
        nudge: Pick<QueueErrand, 'reviewer' | 'message'>,
    ): QueueErrand {
        const errand: QueueErrand = {
            id: this.deps.ids.newId(),
            kind,
            repository,
            number: pr.number,
            title: pr.title,
            url: pr.url,
            ...nudge,
            sessionId: null,
            createdAt: this.deps.clock.now(),
            settledAt: null,
        };
        this.deps.store.add(errand);
        return errand;
    }
}

function repositoryOf(url: string): string {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(url);
    return match ? match[1] : '';
}
