/**
 * Your review of a PR, drawn into its diff (#77, C1–C5): the `+` on a line,
 * the composer under it, your pending comments, the review threads already on
 * GitHub, and the bar that finishes the pending review.
 *
 * A thread shows each comment's author (with a Bot badge for bots), its age
 * and its body. A resolved one is dimmed and says who resolved it. An open one
 * says "needs you" when Claude answered and left it open (C5).
 */
import {useEffect, useId, useRef, useState} from 'react';
import type {FormEvent, JSX, KeyboardEvent} from 'react';
import {useStore} from '../use-store';
import {addReviewComment, closeComposer, finishReview, openComposer} from './actions';
import {initials, pendingLabel} from '../../../domain/session-work/review';
import type {
    DiffLine,
    DiffSide,
    PendingComment,
    PullRequestStatus,
    ReviewThread,
} from '../../../domain/session-work/model';
import {commentAnchor} from '../../../domain/session-work/diff';
import {formatDate} from '../../lib/format';
import type {LineNotes} from './review-notes';

/**
 * The element a composer was opened from, so Esc and Cancel can give it the
 * focus back. Only one composer is ever open.
 */
let opener: HTMLElement | null = null;

/** Open the composer on a line, remembering where the focus was. */
export function startComment(itemId: string, path: string, line: DiffLine, from: HTMLElement | null): void {
    const anchor = commentAnchor(line);
    openComposerAt(itemId, path, anchor.line, anchor.side, from);
}

export function openComposerAt(
    itemId: string,
    path: string,
    line: number,
    side: DiffSide,
    from: HTMLElement | null,
): void {
    opener = from;
    openComposer(itemId, path, line, side);
}

/** Close the composer and put the focus back where it was opened from. */
function dismissComposer(from: HTMLElement | null): void {
    const back = opener;
    opener = null;
    closeComposer();
    const target = back?.isConnected ? back : from?.closest<HTMLElement>('.sw-page');
    target?.focus({preventScroll: true});
}

/** The `+` in a line's first column: shown on hover and focus. */
export function PlusButton({itemId, path, line}: {itemId: string; path: string; line: DiffLine}): JSX.Element {
    const anchor = commentAnchor(line);
    return (
        <button
            type="button"
            className="sw-dl-plus"
            tabIndex={-1}
            aria-label={`Comment on line ${anchor.line}`}
            title="Comment on this line (c)"
            onClick={(e) => {
                const row = (e.currentTarget.closest('[data-comment-line]') as HTMLElement | null) ?? e.currentTarget;
                startComment(itemId, path, line, row);
            }}>
            +
        </button>
    );
}

/** Everything under one line: its threads, your pending comments on it, and the composer when it is open there. */
export function LineNotesView({notes}: {notes: LineNotes}): JSX.Element {
    return (
        <div className="sw-notes">
            {notes.threads.map((thread) => (
                <ThreadView key={thread.id} thread={thread} />
            ))}
            {notes.pending.map((comment, i) => (
                <PendingView key={comment.threadId ?? i} comment={comment} />
            ))}
            {notes.composer && <Composer />}
        </div>
    );
}

/** Threads and pending comments on lines that are no longer in the diff, at the top of their file. */
export function OutdatedNotes({
    threads,
    pending,
}: {
    threads: readonly ReviewThread[];
    pending: readonly PendingComment[];
}): JSX.Element | null {
    if (threads.length === 0 && pending.length === 0) return null;
    const count = threads.length + pending.length;
    return (
        <div
            className="sw-notes is-outdated"
            role="group"
            aria-label="Outdated comments"
            data-testid="session-work-outdated">
            <div className="sw-notes-title">
                Outdated · {count === 1 ? '1 comment' : `${count} comments`} on lines no longer in the diff
            </div>
            {threads.map((thread) => (
                <ThreadView key={thread.id} thread={thread} />
            ))}
            {pending.map((comment, i) => (
                <PendingView key={comment.threadId ?? i} comment={comment} />
            ))}
        </div>
    );
}

function ThreadView({thread}: {thread: ReviewThread}): JSX.Element {
    const where = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
    return (
        <article
            className={'sw-thread' + (thread.resolved ? ' is-resolved' : '')}
            aria-label={`Thread on ${where}`}
            data-testid="session-work-thread"
            data-thread-id={thread.id}>
            {thread.comments.map((comment, i) => (
                <div key={i} className="sw-comment">
                    <span className={'sw-avatar' + (comment.isBot ? ' is-bot' : '')} aria-hidden="true">
                        {initials(comment.author)}
                    </span>
                    <div className="sw-comment-main">
                        <div className="sw-comment-head">
                            <span className="sw-comment-author">{comment.author}</span>
                            {comment.isBot && <span className="sw-pill is-grey">Bot</span>}
                            {comment.createdAt && <CommentAge at={comment.createdAt} />}
                        </div>
                        <div className="sw-comment-body">{comment.body}</div>
                    </div>
                </div>
            ))}
            <ThreadFooter thread={thread} />
        </article>
    );
}

function CommentAge({at}: {at: string}): JSX.Element | null {
    const now = useStore((state) => state.sessionWork.now);
    const time = Date.parse(at);
    if (Number.isNaN(time)) return null;
    return (
        <time className="sw-comment-age" dateTime={at}>
            {formatDate(new Date(time), Math.max(now, time))}
        </time>
    );
}

function ThreadFooter({thread}: {thread: ReviewThread}): JSX.Element {
    if (thread.resolved) {
        return (
            <div className="sw-thread-foot">
                <span className="sw-thread-state">
                    {thread.resolvedBy ? `Resolved by ${thread.resolvedBy}` : 'Resolved'}
                </span>
            </div>
        );
    }
    return <div className="sw-thread-foot">{thread.needsYou && <span className="sw-pill is-red">needs you</span>}</div>;
}

function PendingView({comment}: {comment: PendingComment}): JSX.Element {
    return (
        <div className="sw-pending" data-testid="session-work-pending-comment">
            <div className="sw-pending-label">Pending · goes out with your review</div>
            <div className="sw-comment-body">{comment.body}</div>
        </div>
    );
}

/** The composer under a line: a labelled textarea, Add to review and Cancel. Esc closes it before the page. */
function Composer(): JSX.Element {
    const target = useStore((state) => state.sessionWork.page?.composer ?? null);
    const busy = useStore((state) => state.sessionWork.page?.reviewPending?.kind === 'comment');
    const error = useStore((state) => {
        const failed = state.sessionWork.page?.reviewError;
        return failed?.kind === 'comment' ? failed.message : null;
    });
    const [body, setBody] = useState('');
    const field = useRef<HTMLTextAreaElement>(null);
    const id = useId();

    useEffect(() => {
        field.current?.focus({preventScroll: true});
        field.current?.scrollIntoView({block: 'nearest'});
    }, [target?.path, target?.line, target?.side]);

    const submit = (e?: FormEvent): void => {
        e?.preventDefault();
        if (busy || !body.trim()) return;
        void addReviewComment(body).then((added) => {
            if (added) dismissComposer(null);
        });
    };

    const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
        if (e.key === 'Escape') {
            // The composer goes first; the page only on the next Esc.
            e.preventDefault();
            e.stopPropagation();
            dismissComposer(field.current);
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            submit();
        }
    };

    const side = target?.side === 'LEFT' ? ' (old)' : '';
    return (
        <form className="sw-composer" onSubmit={submit} onKeyDown={onKeyDown} data-testid="session-work-composer">
            <label className="sw-composer-label" htmlFor={id}>
                Comment on line {target?.line}
                {side}
            </label>
            <textarea
                id={id}
                ref={field}
                className="sw-composer-field"
                rows={3}
                value={body}
                placeholder="Leave a comment"
                onChange={(e) => setBody(e.target.value)}
            />
            {error && (
                <div className="sw-note-error" role="alert">
                    {error}
                </div>
            )}
            <div className="sw-composer-actions">
                <button type="button" className="sw-btn sw-btn-small" onClick={() => dismissComposer(field.current)}>
                    Cancel
                </button>
                <button
                    type="submit"
                    className="sw-btn sw-btn-small is-primary"
                    aria-disabled={busy || !body.trim() ? true : undefined}>
                    {busy ? 'Adding…' : 'Add to review'}
                </button>
            </div>
        </form>
    );
}

/**
 * The bar under the diff while your review has pending comments (C2):
 * Discard, and Submit.
 */
export function ReviewBar({itemId, pr}: {itemId: string; pr: PullRequestStatus}): JSX.Element | null {
    const busy = useStore((state) => {
        const pending = state.sessionWork.page?.reviewPending;
        return pending && pending.kind !== 'comment' ? pending.kind : null;
    });
    const error = useStore((state) => {
        const failed = state.sessionWork.page?.reviewError;
        return failed && failed.kind !== 'comment' && failed.itemId === itemId ? failed.message : null;
    });
    const count = pr.pendingReview?.length ?? 0;
    if (count === 0) return null;

    return (
        <div className="sw-review-bar" role="region" aria-label="Pending review" data-testid="session-work-review-bar">
            <span className="sw-review-dot" aria-hidden="true" />
            <span className="sw-review-label">{pendingLabel(count)}</span>
            {error && (
                <span className="sw-note-error" role="alert">
                    {error}
                </span>
            )}
            <span className="sw-review-actions">
                <button
                    type="button"
                    className="sw-btn sw-btn-small"
                    aria-disabled={busy ? true : undefined}
                    onClick={() => {
                        if (!busy) void finishReview(itemId, 'discard');
                    }}>
                    {busy === 'discard' ? 'Discarding…' : 'Discard'}
                </button>
                <button
                    type="button"
                    className="sw-btn sw-btn-small is-primary"
                    title="Submit the review as a comment"
                    aria-disabled={busy ? true : undefined}
                    onClick={() => {
                        if (!busy) void finishReview(itemId, 'submit');
                    }}>
                    {busy === 'submit' ? 'Submitting…' : 'Submit'}
                </button>
            </span>
        </div>
    );
}
