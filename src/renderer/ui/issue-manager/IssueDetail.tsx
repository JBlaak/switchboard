/**
 * The selected issue on the Issue manager page (#415): its title with Open
 * in GitHub, the newest of its thread, your notes (saved as you type),
 * Comment… with its editable preview, and what you can do with it: Start
 * and claim, Snooze and Backlog in the inbox; Open session and Stop working
 * on it once started. Its × (or Esc) puts it away until another row is picked.
 */
import {useEffect, useRef, type JSX} from 'react';
import {useStore} from '../use-store';
import {formatDate} from '../../lib/format';
import {THREAD_SHOWN} from '../../../domain/inbox/issue-manager';
import type {InboxItem, InboxStage} from '../../../domain/inbox/model';
import type {IssueManagerState} from '../../state/issue-manager-slice';
import {inProgressPill, landedForItem} from '../../../domain/merge-manager/stage-words';
import {
    askStopWork,
    backlogIssue,
    commentFromNotes,
    confirmStopWork,
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
    const snoozeOptions = page.snooze?.key === item.key ? page.snooze.options : undefined;

    // The Snooze menu comes into view with its first option under the keyboard.
    useEffect(() => {
        if (!snoozeOptions) return;
        menu.current?.scrollIntoView({block: 'nearest'});
        menu.current?.querySelector<HTMLButtonElement>('.im-menu-item')?.focus({preventScroll: true});
    }, [snoozeOptions]);

    if (item.facts.kind !== 'issue') return null;
    const facts = item.facts;
    const load = page.threads[item.key];
    const thread = load?.phase === 'ok' ? load.thread : null;
    const shown = thread ? thread.comments.slice(-THREAD_SHOWN) : [];
    const state = item.state.kind;
    const working = state === 'inProgress';
    const comment = page.comment?.key === item.key ? page.comment : null;
    const start = page.start?.key === item.key ? page.start : null;
    const stop = page.stop?.key === item.key ? page.stop : null;
    const snooze = page.snooze?.key === item.key ? page.snooze : null;

    return (
        <aside className="im-detail" aria-label="Issue detail">
            <div className="im-meta">
                {working && <StagePill item={item} stage={(item.state as {stage: InboxStage}).stage} />}
                <span>
                    {facts.repository} #{facts.number}
                </span>
                <span>·</span>
                <span>
                    {facts.author ?? 'ghost'} · {facts.comments} {facts.comments === 1 ? 'comment' : 'comments'}
                </span>
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
            <div className="im-titlerow">
                <h2 className="im-title">{facts.title}</h2>
                <button type="button" className="im-out" onClick={() => openOnGitHub(item)}>
                    Open in GitHub ↗
                </button>
            </div>
            {item.work?.pullRequest && (
                <button type="button" className="im-out is-quiet" onClick={() => openPullRequest(item)}>
                    {state === 'done'
                        ? `Closed by #${item.work.pullRequest}`
                        : `Open PR #${item.work.pullRequest} in GitHub`}{' '}
                    ↗
                </button>
            )}

            <section className="im-box" aria-label="Thread">
                <span className="im-box-label">
                    {thread && thread.total > shown.length
                        ? `Thread · newest ${shown.length} of ${thread.total}`
                        : 'Thread'}
                </span>
                {!load || load.phase === 'loading' ? (
                    <div className="pp-quiet">Reading the thread…</div>
                ) : !thread ? (
                    <div className="pp-quiet">Could not read the thread from GitHub.</div>
                ) : shown.length === 0 ? (
                    <div className="im-msg-body">{thread.body.trim() || 'No description.'}</div>
                ) : (
                    shown.map((c, i) => (
                        <div key={i} className="im-msg">
                            <span className="im-avatar" aria-hidden="true">
                                {(c.author ?? '?').slice(0, 1).toUpperCase()}
                            </span>
                            <div>
                                <b>{c.author ?? 'ghost'}</b> ·{' '}
                                {c.createdAt ? formatDate(new Date(c.createdAt), now) : ''}
                                <div className="im-msg-body">{c.body}</div>
                            </div>
                        </div>
                    ))
                )}
            </section>

            <section className="im-box" aria-label="Your notes">
                <span className="im-box-label">
                    Your notes · optional <kbd className="sw-kbd">C</kbd>
                </span>
                <textarea
                    className="im-notes"
                    aria-label="Your notes"
                    placeholder="Context for the session, or what to say on the issue…"
                    value={item.notes}
                    rows={4}
                    spellCheck
                    onChange={(e) => typeNotes(item.key, e.target.value)}
                    onBlur={() => void flushNotes(item.key)}
                />
                <div className="im-actions">
                    <button
                        type="button"
                        className="sw-btn"
                        disabled={comment?.phase === 'polishing' || comment?.phase === 'posting'}
                        onClick={() => void commentFromNotes(item.key, false)}>
                        Comment… <kbd className="sw-kbd">M</kbd>
                    </button>
                    <button
                        type="button"
                        className="sw-btn is-ghost"
                        disabled={comment?.phase === 'polishing' || comment?.phase === 'posting'}
                        onClick={() => void commentFromNotes(item.key, true)}>
                        Polish and post now <kbd className="sw-kbd">⇧M</kbd>
                    </button>
                </div>
                <span className="im-help">
                    Saved as you type. Start puts your notes in the prompt. Comment… has Claude polish them for you to
                    edit before posting; every comment ends with a line saying it was polished with Claude.
                </span>
            </section>

            {comment && <CommentBox comment={comment} onFocusRows={onFocusRows} />}

            {start?.phase === 'failed' && (
                <div className="tk-status is-error" role="alert">
                    {start.reason}
                </div>
            )}

            {stop ? (
                <div className="im-box im-ask" role="group" aria-label="Stop working on it">
                    <span>Stop working on #{facts.number}? It goes back to the inbox.</span>
                    <label className="im-check">
                        <input type="checkbox" checked={stop.unassign} onChange={toggleStopUnassign} /> Also unassign me
                        on GitHub
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
            ) : working ? (
                <div className="im-actions">
                    <button type="button" className="sw-btn is-primary" onClick={() => void openIssueSession(item)}>
                        Open session <kbd className="sw-kbd">↵</kbd>
                    </button>
                    <button type="button" className="sw-btn" onClick={() => askStopWork(item.key)}>
                        Stop working on it
                    </button>
                </div>
            ) : (
                <div className="im-actions">
                    <button
                        type="button"
                        className="sw-btn is-primary"
                        disabled={start?.phase === 'starting'}
                        onClick={() => void startIssue(item.key)}>
                        {start?.phase === 'starting' ? 'Starting…' : 'Start and claim'} <kbd className="sw-kbd">↵</kbd>
                    </button>
                    {state !== 'done' && (
                        <>
                            <button type="button" className="sw-btn" onClick={() => void openSnooze(item.key)}>
                                Snooze <kbd className="sw-kbd">S</kbd>
                            </button>
                            <button type="button" className="sw-btn" onClick={() => void backlogIssue(item.key)}>
                                Backlog <kbd className="sw-kbd">B</kbd>
                            </button>
                        </>
                    )}
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
                        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('.im-menu-item') ?? [])];
                        const at = items.indexOf(document.activeElement as HTMLButtonElement);
                        items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
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
        </aside>
    );
}

function CommentBox({
    comment,
    onFocusRows,
}: {
    comment: NonNullable<IssueManagerState['comment']>;
    onFocusRows: () => void;
}): JSX.Element {
    if (comment.phase === 'polishing') {
        return (
            <div className="im-box im-preview" role="status">
                Claude is polishing your notes…
            </div>
        );
    }
    if (comment.phase === 'posted') {
        return (
            <div className="im-box im-preview" role="status">
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
            <div className="im-box im-preview" role="alert">
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
        <section className="im-box im-preview" aria-label="Comment preview">
            <span className="im-box-label">Comment preview · edit before posting</span>
            <textarea
                className="im-notes"
                aria-label="Comment"
                value={comment.body}
                rows={6}
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
