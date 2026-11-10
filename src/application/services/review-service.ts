/**
 * Your review of a session's PR, from the Session work page (C1–C3).
 *
 * Line comments collect in a pending GitHub review — the same one GitHub's own
 * page uses, so a review started in the browser is carried on here and the
 * other way round. The review is finished by submitting it as a comment, or
 * by discarding it.
 *
 * These are the only writes Switchboard makes to GitHub, and they are made
 * here rather than typed into the session, because they are your words, not
 * Claude's (C3). After each one the page asks `gh` again, so it shows what
 * GitHub made of it. Writes go one at a time: two comments added at once must
 * not each start a review of their own.
 */
import {canComment} from '../../domain/session-work/review';
import type {CommentRequest, ReviewMode, ReviewRequest, ReviewResult} from '../../domain/session-work/review';
import type {PullRequestStatus, SessionWorkItem, WorkPageContext} from '../../domain/session-work/model';
import type {GitHubCli} from '../ports/github-cli';
import type {Logger} from '../ports/logger';

/** The Session work page, as far as your review needs it. */
export interface ReviewPage {
    item(sessionId: string, itemId: string): SessionWorkItem | null;
    context(sessionId: string): WorkPageContext | null;
    /** Ask `gh` again and push the page's snapshot. */
    refreshGitHub(sessionId: string): Promise<void>;
}

export interface ReviewServiceDeps {
    github: Pick<GitHubCli, 'startPendingReview' | 'addPendingComment' | 'deletePendingReview' | 'submitPendingReview'>;
    page: ReviewPage;
    log: Logger;
}

type PullRequestItem = Extract<SessionWorkItem, {kind: 'pr'}>;

export class ReviewService {
    /**
     * Reviews started here that the page may not show yet, by PR URL: the next
     * comment goes into the same one even before `gh` has been asked again.
     */
    private readonly started = new Map<string, string>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly deps: ReviewServiceDeps) {}

    /** Add a line comment to your pending review on the PR, starting one if there is none. */
    public comment(request: CommentRequest): Promise<ReviewResult> {
        return this.serial(() => this.addComment(request));
    }

    /** Finish your pending review on the PR (C2). */
    public review(request: ReviewRequest): Promise<ReviewResult> {
        return this.serial(() => this.finish(request.sessionId, request.itemId, request.mode));
    }

    private async addComment(request: CommentRequest): Promise<ReviewResult> {
        const found = this.item(request.sessionId, request.itemId);
        if (!found.ok) return found;
        const {pr} = found.item;
        const body = request.body.trim();
        if (!body) return {ok: false, reason: 'Write something first'};
        if (!request.path || !Number.isSafeInteger(request.line) || request.line < 1) {
            return {ok: false, reason: 'That line cannot take a comment'};
        }

        let reviewId = this.reviewId(pr);
        if (!reviewId) {
            if (!pr.nodeId) return {ok: false, reason: 'GitHub has not said enough about this PR yet'};
            const started = await this.deps.github.startPendingReview(pr.nodeId);
            if (!started.ok) return this.failed('start a review', started.reason);
            reviewId = started.reviewId;
            this.started.set(pr.url, reviewId);
        }
        const added = await this.deps.github.addPendingComment(reviewId, {
            path: request.path,
            line: request.line,
            side: request.side === 'LEFT' ? 'LEFT' : 'RIGHT',
            body,
        });
        await this.deps.page.refreshGitHub(request.sessionId);
        // Once the page shows the review, it is the one to go by: should it be
        // submitted in the browser, the page stops showing it and nothing stale is kept.
        const after = this.deps.page.item(request.sessionId, request.itemId);
        if (after?.kind === 'pr' && after.pr.pendingReviewId) this.started.delete(pr.url);
        return added.ok ? {ok: true} : this.failed('add the comment', added.reason);
    }

    private async finish(sessionId: string, itemId: string, mode: ReviewMode): Promise<ReviewResult> {
        const found = this.item(sessionId, itemId);
        if (!found.ok) return found;
        const {pr} = found.item;
        const reviewId = this.reviewId(pr);
        if (!reviewId) return {ok: false, reason: 'There is no review in progress'};

        if (mode === 'discard') {
            const deleted = await this.deps.github.deletePendingReview(reviewId);
            if (deleted.ok) this.started.delete(pr.url);
            await this.deps.page.refreshGitHub(sessionId);
            return deleted.ok ? {ok: true} : this.failed('discard the review', deleted.reason);
        }

        const pending = pr.pendingReview ?? [];
        if (pending.length === 0) return {ok: false, reason: 'The review has no comments yet'};

        const submitted = await this.deps.github.submitPendingReview(reviewId, 'COMMENT');
        if (submitted.ok) this.started.delete(pr.url);
        await this.deps.page.refreshGitHub(sessionId);
        return submitted.ok ? {ok: true} : this.failed('submit the review', submitted.reason);
    }

    /** The PR item a review is about, when it can take one. */
    private item(sessionId: string, itemId: string): {ok: true; item: PullRequestItem} | {ok: false; reason: string} {
        const item = this.deps.page.item(sessionId, itemId);
        const context = this.deps.page.context(sessionId);
        if (!item || !context) return {ok: false, reason: 'This item is no longer on the page'};
        if (item.kind !== 'pr') return {ok: false, reason: 'Only a PR can be reviewed'};
        if (context.gh !== 'ok') return {ok: false, reason: 'gh is needed to review on GitHub'};
        if (!canComment(item, context.gh)) return {ok: false, reason: 'This PR is no longer open'};
        return {ok: true, item};
    }

    /** Your pending review on the PR: the one GitHub reported, else one started here since. */
    private reviewId(pr: PullRequestStatus): string | null {
        return pr.pendingReviewId ?? this.started.get(pr.url) ?? null;
    }

    private failed(what: string, reason: string): ReviewResult {
        this.deps.log.warn(`[session-work] could not ${what}: ${reason}`);
        return {ok: false, reason: `Could not ${what}: ${reason}`};
    }

    /** Run one write after the one before it has finished. */
    private serial<T>(write: () => Promise<T>): Promise<T> {
        const next = this.queue.then(write, write);
        this.queue = next.catch(() => undefined);
        return next;
    }
}
