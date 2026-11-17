/**
 * The selected issue on the Issue manager page (#415), taking the page while
 * the list is a rail beside it: a header with where it stands, its title and
 * what you can do with it (Start and claim, Snooze and Backlog in the inbox;
 * Open session and Stop working on it once started; Close on GitHub while it
 * is open, with a comment to post as it closes if you like), the whole conversation
 * read from GitHub (the ticket first, then its comments, with "new since you
 * looked" where the unread ones start, and the polished comment waiting to be
 * posted at the end), and your notes docked under it with Comment… and Polish
 * and post now. Its × (or Esc) puts it away until another row is picked.
 */
import {useEffect, useRef, type JSX} from 'react';
import {useStore} from '../use-store';
import {formatDate} from '../../lib/format';
import {newSinceAt} from '../../../domain/inbox/issue-manager';
import type {InboxItem, InboxStage} from '../../../domain/inbox/model';
import type {IssueManagerState} from '../../state/issue-manager-slice';
import {inProgressPill, landedForItem} from '../../../domain/merge-manager/stage-words';
import {
    askCloseIssue,
    askStopWork,
    backlogIssue,
    commentFromNotes,
    confirmCloseIssue,
    confirmStopWork,
    dismissCloseIssue,
    dismissComment,
    dismissStopWork,
    editComment,
    flushNotes,
    openIssueSession,
    openOnGitHub,
    openPullRequest,
    openSnooze,
    postComment,
    selectIssue,
    snoozeIssue,
    startIssue,
    toggleStopUnassign,
    typeCloseComment,
    typeNotes,
} from './actions';

/**
 * An in-progress item's stage: once its PR is landed, the Merge manager's
 * stage in the words every place shares (#441); its own stage before.
 */
export function StagePill({item, stage}: {item: InboxItem; stage: InboxStage}): JSX.Element {
    const merge = useStore((state) => state.mergeManager.state);
    const pill = inProgressPill(stage, landedForItem(merge, item));
    return (
        <span className={'im-stage is-' + pill.kind} title={pill.title ?? undefined}>
            <i aria-hidden="true" />
            {pill.label}
        </span>
    );
}

/** The avatar's tint: the same login always gets the same one. */
function tintOf(login: string | null): number {
    let sum = 0;
    for (const char of login ?? '') sum += char.charCodeAt(0);
    return sum % 4;
}

function Message({
    author,
    at,
    body,
    opened,
    now,
}: {
    author: string | null;
    at: string;
    body: string;
    opened?: boolean;
    now: number;
}): JSX.Element {
    return (
        <article className="im-msg">
            <span className={'im-avatar is-tint' + tintOf(author)} aria-hidden="true">
                {(author ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <div className="im-msg-main">
                <div className="im-msg-head">
                    <b>{author ?? 'ghost'}</b>
                    {opened ? ' opened the issue' : ''}
                    {at ? ` · ${formatDate(new Date(at), now)}` : ''}
                </div>
                <div className="im-msg-body">{body}</div>
            </div>
        </article>
    );
}

export function IssueDetail({
    item,
    page,
    onFocusRows,
}: {
    item: InboxItem;
    page: IssueManagerState;
    onFocusRows: () => void;
}): JSX.Element | null {
    const now = useStore((state) => state.sessionList.now) || Date.now();
    const menu = useRef<HTMLDivElement>(null);
    const thread = useRef<HTMLDivElement>(null);
    const snoozeOptions = page.snooze?.key === item.key ? page.snooze.options : undefined;
    const commentPhase = page.comment?.key === item.key ? page.comment.phase : null;

    // The Snooze menu comes into view with its first option under the keyboard.
    useEffect(() => {
        if (!snoozeOptions) return;
        menu.current?.querySelector<HTMLButtonElement>('.im-menu-item')?.focus({preventScroll: true});
    }, [snoozeOptions]);

    // Another issue opens at the top of its conversation.
    useEffect(() => {
        thread.current?.scrollTo({top: 0});
    }, [item.key]);

    // The polished comment shows where it will land: at the end of the thread.
    useEffect(() => {
        if (commentPhase !== 'polishing' && commentPhase !== 'preview') return;
        const box = thread.current;
        box?.scrollTo({top: box.scrollHeight, behavior: 'smooth'});
    }, [commentPhase]);

    if (item.facts.kind !== 'issue') return null;
    const facts = item.facts;
    const load = page.threads[item.key];
    const read = load?.phase === 'ok' ? load.thread : null;
    const comments = read?.comments ?? [];
    const earlier = read ? read.total - comments.length : 0;
    const marker = newSinceAt(comments.length, page.fresh[item.key] ?? 0);
    const state = item.state.kind;
    const working = state === 'inProgress';
    const comment = page.comment?.key === item.key ? page.comment : null;
    const start = page.start?.key === item.key ? page.start : null;
    const stop = page.stop?.key === item.key ? page.stop : null;
    const snooze = page.snooze?.key === item.key ? page.snooze : null;
    const close = page.close?.key === item.key ? page.close : null;
    const busy = comment?.phase === 'polishing' || comment?.phase === 'posting';

    return (
        <aside className="im-detail" aria-label="Issue detail">
            <header className="im-head">
                <div className="im-head-bar">
                    {working ? (
                        <StagePill item={item} stage={(item.state as {stage: InboxStage}).stage} />
                    ) : state === 'done' ? (
                        <span className="im-chip is-done">Done</span>
                    ) : (
                        <span className="im-open">Open</span>
                    )}
                    <span className="im-ref">
                        {facts.repository} #{facts.number}
                    </span>
                    <span className="im-head-gap" />
                    {working ? (
                        <>
                            <button
                                type="button"
                                className="sw-btn is-primary"
                                onClick={() => void openIssueSession(item)}>
                                Open session <kbd className="sw-kbd">↵</kbd>
                            </button>
                            <button type="button" className="sw-btn" onClick={() => askStopWork(item.key)}>
                                Stop working on it
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                type="button"
                                className="sw-btn is-primary"
                                disabled={start?.phase === 'starting'}
                                onClick={() => void startIssue(item.key)}>
                                {start?.phase === 'starting' ? 'Starting…' : 'Start and claim'}{' '}
                                <kbd className="sw-kbd">↵</kbd>
                            </button>
                            {state !== 'done' && (
                                <>
                                    <button type="button" className="sw-btn" onClick={() => void openSnooze(item.key)}>
                                        Snooze <kbd className="sw-kbd">S</kbd>
                                    </button>
                                    <button
                                        type="button"
                                        className="sw-btn"
                                        onClick={() => void backlogIssue(item.key)}>
                                        Backlog <kbd className="sw-kbd">B</kbd>
                                    </button>
                                </>
                            )}
                        </>
                    )}
                    {state !== 'done' && (
                        <button
                            type="button"
                            className="sw-btn"
                            disabled={close?.phase === 'closing'}
                            onClick={() => askCloseIssue(item.key)}>
                            Close on GitHub
                        </button>
                    )}
                    <button type="button" className="im-out" onClick={() => openOnGitHub(item)}>
                        Open in GitHub ↗
                    </button>
                    <button
                        type="button"
                        className="im-close"
                        aria-label="Close the issue (Esc)"
                        title="Close (Esc)"
                        onClick={() => {
                            selectIssue(null);
                            onFocusRows();
                        }}>
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true">
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <h2 className="im-title">{facts.title}</h2>

                <div className="im-facts">
                    {facts.labels.map((label) => (
                        <span key={label.name} className="im-label">
                            {label.name}
                        </span>
                    ))}
                    <span>
                        opened by <b>{facts.author ?? 'ghost'}</b> {formatDate(new Date(facts.createdAt), now)} ·{' '}
                        {facts.comments} {facts.comments === 1 ? 'comment' : 'comments'} ·{' '}
                        {facts.assignees.length > 0 ? `assigned to ${facts.assignees.join(', ')}` : 'unassigned'}
                        {facts.references > 0
                            ? ` · referenced in ${facts.references} ${facts.references === 1 ? 'commit' : 'commits'}`
                            : ''}
                    </span>
                </div>

                {item.work?.pullRequest && (
                    <div className="im-work">
                        <span>
                            <b>PR #{item.work.pullRequest}</b>
                            {state === 'done' ? ' closed it' : ' closes it'}
                        </span>
                        <span className="im-head-gap" />
                        <button type="button" className="im-out is-quiet" onClick={() => openPullRequest(item)}>
                            {state === 'done'
                                ? `Closed by #${item.work.pullRequest}`
                                : `Open PR #${item.work.pullRequest} in GitHub`}{' '}
                            ↗
                        </button>
                    </div>
                )}

                {start?.phase === 'failed' && (
                    <div className="tk-status is-error" role="alert">
                        {start.reason}
                    </div>
                )}

                {stop && (
                    <div className="im-box im-ask" role="group" aria-label="Stop working on it">
                        <span>Stop working on #{facts.number}? It goes back to the inbox.</span>
                        <label className="im-check">
                            <input type="checkbox" checked={stop.unassign} onChange={toggleStopUnassign} /> Also
                            unassign me on GitHub
                        </label>
                        <div className="im-actions">
                            <button type="button" className="sw-btn is-primary" onClick={() => void confirmStopWork()}>
                                Stop working on it
                            </button>
                            <button type="button" className="sw-btn is-ghost" onClick={dismissStopWork}>
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {close && (
                    <div className="im-box im-ask" role="group" aria-label="Close on GitHub">
                        <span>Close #{facts.number} on GitHub? It moves to Done here.</span>
                        <textarea
                            className="im-notes"
                            aria-label="Closing comment"
                            placeholder="A comment to post as it closes (optional)"
                            value={close.comment}
                            rows={3}
                            spellCheck
                            autoFocus
                            readOnly={close.phase === 'closing'}
                            onChange={(e) => typeCloseComment(e.target.value)}
                        />
                        {close.phase === 'failed' && (
                            <div className="tk-status is-error" role="alert">
                                {close.reason}
                            </div>
                        )}
                        <div className="im-actions">
                            <button
                                type="button"
                                className="sw-btn is-primary"
                                disabled={close.phase === 'closing'}
                                onClick={() => {
                                    void confirmCloseIssue();
                                    onFocusRows();
                                }}>
                                {close.phase === 'closing'
                                    ? 'Closing…'
                                    : close.comment.trim()
                                      ? 'Comment and close'
                                      : 'Close issue'}
                            </button>
                            <button
                                type="button"
                                className="sw-btn is-ghost"
                                disabled={close.phase === 'closing'}
                                onClick={dismissCloseIssue}>
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {snooze && (
                    <div
                        ref={menu}
                        className="im-menu"
                        role="menu"
                        aria-label="Snooze until"
                        onKeyDown={(e) => {
                            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                            e.preventDefault();
                            const items = [
                                ...(menu.current?.querySelectorAll<HTMLButtonElement>('.im-menu-item') ?? []),
                            ];
                            const at = items.indexOf(document.activeElement as HTMLButtonElement);
                            items[
                                Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
                            ]?.focus();
                        }}>
                        <div className="im-menu-label">Snooze until</div>
                        {snooze.options === null ? (
                            <div className="pp-quiet">…</div>
                        ) : (
                            snooze.options.map((option) => (
                                <button
                                    key={option.kind}
                                    type="button"
                                    role="menuitem"
                                    className="im-menu-item"
                                    onClick={() => {
                                        void snoozeIssue(item.key, option.until);
                                        onFocusRows();
                                    }}>
                                    {option.label}
                                    <span>
                                        {option.until
                                            ? new Date(option.until).toLocaleDateString('en-GB', {
                                                  weekday: 'short',
                                                  day: 'numeric',
                                                  month: 'short',
                                              })
                                            : 'a new comment or commit'}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                )}
            </header>

            <div ref={thread} className="im-thread">
                <section className="im-thread-col" aria-label="Thread">
                    {!load || load.phase === 'loading' ? (
                        <div className="pp-quiet">Reading the thread…</div>
                    ) : !read ? (
                        <div className="pp-quiet">Could not read the thread from GitHub.</div>
                    ) : (
                        <>
                            <Message
                                author={facts.author}
                                at={facts.createdAt}
                                body={read.body.trim() || 'No description.'}
                                opened
                                now={now}
                            />
                            {earlier > 0 && (
                                <div className="im-event">
                                    {earlier} earlier {earlier === 1 ? 'comment' : 'comments'} ·{' '}
                                    <button type="button" className="im-link" onClick={() => openOnGitHub(item)}>
                                        read them on GitHub
                                    </button>
                                </div>
                            )}
                            {comments.map((c, i) => (
                                <div key={i} className="im-thread-item">
                                    {marker === i && (
                                        <div className="im-new-since" role="separator">
                                            {comments.length - i} new since you looked
                                        </div>
                                    )}
                                    <Message author={c.author} at={c.createdAt} body={c.body} now={now} />
                                </div>
                            ))}
                        </>
                    )}
                    {comment && <CommentBox comment={comment} onFocusRows={onFocusRows} />}
                </section>
            </div>

            <section className="im-composer" aria-label="Your notes">
                <div className="im-composer-col">
                    <div className="im-composer-head">
                        <span className="im-box-label">
                            Your notes <kbd className="sw-kbd">C</kbd>
                        </span>
                        <span className="im-help">
                            Saved as you type · Start puts them in the prompt · Comment… polishes them for you to edit
                            before posting
                        </span>
                    </div>
                    <textarea
                        className="im-notes"
                        aria-label="Your notes"
                        placeholder="Context for the session, or what to say on the issue…"
                        value={item.notes}
                        rows={2}
                        spellCheck
                        onChange={(e) => typeNotes(item.key, e.target.value)}
                        onBlur={() => void flushNotes(item.key)}
                    />
                    <div className="im-actions">
                        <button
                            type="button"
                            className="sw-btn"
                            disabled={busy}
                            onClick={() => void commentFromNotes(item.key, false)}>
                            Comment… <kbd className="sw-kbd">M</kbd>
                        </button>
                        <button
                            type="button"
                            className="sw-btn is-ghost"
                            disabled={busy}
                            onClick={() => void commentFromNotes(item.key, true)}>
                            Polish and post now <kbd className="sw-kbd">⇧M</kbd>
                        </button>
                    </div>
                </div>
            </section>
        </aside>
    );
}

/** The comment Claude polished from your notes, at the end of the thread where it will land. */
function CommentBox({
    comment,
    onFocusRows,
}: {
    comment: NonNullable<IssueManagerState['comment']>;
    onFocusRows: () => void;
}): JSX.Element {
    if (comment.phase === 'polishing') {
        return (
            <div className="im-reply" role="status">
                Claude is polishing your notes…
            </div>
        );
    }
    if (comment.phase === 'posted') {
        return (
            <div className="im-reply" role="status">
                Posted on GitHub. Your notes are kept.
                <div className="im-actions">
                    <button type="button" className="sw-btn is-ghost" onClick={dismissComment}>
                        OK
                    </button>
                </div>
            </div>
        );
    }
    if (comment.phase === 'failed') {
        return (
            <div className="im-reply" role="alert">
                <span className="is-error">{comment.reason}</span>
                <div className="im-actions">
                    <button type="button" className="sw-btn is-ghost" onClick={dismissComment}>
                        Back to notes
                    </button>
                </div>
            </div>
        );
    }
    return (
        <section className="im-reply" aria-label="Comment preview">
            <span className="im-box-label">
                Your comment <span className="im-reply-tag">Polished · not posted</span>
            </span>
            <textarea
                className="im-notes"
                aria-label="Comment"
                value={comment.body}
                rows={5}
                readOnly={comment.phase === 'posting'}
                onChange={(e) => editComment(e.target.value)}
            />
            <p className="im-footer-line">{comment.footer}</p>
            <div className="im-actions">
                <button
                    type="button"
                    className="sw-btn is-primary"
                    disabled={comment.phase === 'posting' || !comment.body.trim()}
                    onClick={() => {
                        void postComment();
                        onFocusRows();
                    }}>
                    {comment.phase === 'posting' ? 'Posting…' : 'Post'}
                </button>
                <button type="button" className="sw-btn is-ghost" onClick={dismissComment}>
                    Back to notes
                </button>
            </div>
        </section>
    );
}
