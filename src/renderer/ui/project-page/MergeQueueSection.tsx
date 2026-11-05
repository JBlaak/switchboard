/**
 * The project page's Merge queue section (#315), over Pull requests, for a
 * repository whose PRs merge through its serial merge queue; left out for
 * one that has none.
 *
 * The heading counts what is queued, held and failed, and says when the
 * queue clears. The head is a card of its own: its branch, who approved it,
 * the session that owns it, when it merges and its four steps. Behind it, on
 * a rail, the entries in the queue's order, each with one sentence on why it
 * is there and when it merges; a stack lists its members bottom-up, and a
 * held entry waiting for a review offers Nudge <reviewer>. Out of the queue,
 * in red, the failed entries with the queue's reason, Fix in session and
 * Retry; then the PRs the queue could not be read for, in its own words.
 *
 * Each entry is a cursor row (↵, or a click, opens it on GitHub). What it
 * says is `merge-queue-view`; what its buttons do, `merge-queue-actions`.
 */
import type {JSX, MouseEvent, ReactNode} from 'react';
import {useStore} from '../use-store';
import {sessionMap, view} from '../../state/session-store';
import {sessionDisplayName} from '../../state/session-list-layout';
import {queueActionKey, type QueueActionState} from '../../state/project-page-slice';
import type {
    EntryMember,
    FailedEntry,
    QueueHead,
    QueuedEntry,
    UnknownEntry,
} from '../../../domain/project/merge-queue';
import type {QueueErrandView} from '../../../domain/project/queue-errands';
import type {IssueKey} from '../../../domain/plan/model';
import {cursorId} from './page-rows';
import {openProjectSession, openPullRequestOnGitHub} from './actions';
import {fixInSession, nudgeReviewer, retryQueueEntry} from './merge-queue-actions';
import {
    approvedText,
    clockTime,
    countsText,
    estimateText,
    failureLabel,
    fixStatus,
    headSteps,
    isEmptyQueue,
    mergeQueueOf,
    minutesOf,
    nudgePullRequest,
    nudgeStatus,
    reviewerOf,
} from './merge-queue-view';
import {pullRequestSession} from './project-sessions';

interface Context {
    readonly projectPath: string;
    readonly repository: string;
    readonly cursor: string | null;
    readonly errands: readonly QueueErrandView[];
    readonly actions: Readonly<Record<string, QueueActionState>>;
}

export function MergeQueueSection({projectPath}: {projectPath: string}): JSX.Element | null {
    const page = useStore((state) => state.projectPage);
    // The head's owning session is read from the cached projects, which change with the list's redraws.
    useStore((state) => state.sessionList.revision);
    const now = useStore((state) => state.sessionList.now) || Date.now();
    const queue = mergeQueueOf(page, projectPath);
    const repository = page.overview?.repository ?? null;
    if (!queue || !repository) return null;

    const context: Context = {
        projectPath,
        repository,
        cursor: page.cursor,
        errands: page.queueErrands?.repository === repository ? page.queueErrands.errands : [],
        actions: page.queueActions,
    };
    const counts = countsText(queue.counts);

    return (
        <section className="pp-section pp-mq" aria-labelledby="pp-mq-heading">
            <div className="pp-section-head">
                <h2 id="pp-mq-heading">Merge queue</h2>
                {counts && <span className="pp-count">{counts}</span>}
                {queue.clearsInMs !== null && (
                    <span className="pp-mq-clears">
                        Clears in about <strong>{minutesOf(queue.clearsInMs)} min</strong>
                    </span>
                )}
            </div>
            <div className="pp-card pp-mq-card">
                {isEmptyQueue(queue) && <div className="pp-quiet">Nothing queued.</div>}
                {queue.head && <HeadCard head={queue.head} context={context} now={now} />}
                {queue.entries.length > 0 && (
                    <div className="pp-mq-rail">
                        {queue.entries.map((entry) => (
                            <EntryRow key={entry.number} entry={entry} context={context} />
                        ))}
                    </div>
                )}
                {queue.failed.length > 0 && (
                    <>
                        <div className="pp-mq-subhead is-failed">Out of the queue</div>
                        <div className="pp-mq-group">
                            {queue.failed.map((entry) => (
                                <FailedRow key={entry.number} entry={entry} context={context} />
                            ))}
                        </div>
                    </>
                )}
                {queue.unknown.length > 0 && (
                    <>
                        <div className="pp-mq-subhead">Not understood</div>
                        <div className="pp-mq-group">
                            {queue.unknown.map((entry) => (
                                <UnknownRow key={entry.number} entry={entry} context={context} />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </section>
    );
}

// ── Pieces ──

/** The props a cursor row carries: its id, its class, and a click that opens its PR on GitHub. */
function rowProps(context: Context, number: number, className: string) {
    const key: IssueKey = {repository: context.repository, number};
    const id = cursorId.queueEntry(key);
    return {
        className: className + (context.cursor === id ? ' is-cursor' : ''),
        'data-cursor-id': id,
        onClick: () => openPullRequestOnGitHub(key),
    };
}

/** A button inside a row: its click is its own, not the row's. */
function RowButton({
    children,
    onClick,
    accent = false,
    disabled = false,
}: {
    children: ReactNode;
    onClick?: () => void;
    accent?: boolean;
    disabled?: boolean;
}): JSX.Element {
    return (
        <button
            type="button"
            className={'sw-btn sw-btn-small' + (accent ? ' pp-mq-accent' : '')}
            disabled={disabled}
            onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onClick?.();
            }}>
            {children}
        </button>
    );
}

/** A session, by its name, as a link that opens it. */
function SessionLink({sessionId}: {sessionId: string}): JSX.Element {
    const session = sessionMap.get(sessionId);
    const name = session ? sessionDisplayName(session) : '';
    return (
        <button
            type="button"
            className="pp-inline-link pp-mq-session"
            onClick={(e: MouseEvent) => {
                e.stopPropagation();
                openProjectSession(sessionId);
            }}>
            <span className="pp-mq-session-dot" aria-hidden="true" />
            {name ? `session “${name}”` : 'its session'}
        </button>
    );
}

function TitleLine({title, number, children}: {title: string; number?: number; children?: ReactNode}): JSX.Element {
    return (
        <span className="pp-mq-title-line">
            <span className="pp-mq-title">{title}</span>
            {number !== undefined && <span className="pp-num">#{number}</span>}
            {children}
        </span>
    );
}

/** A stack's members, top first as GitHub stacks them, numbered bottom-up (↑1 is the bottom). */
function StackMembers({members, running}: {members: readonly EntryMember[]; running?: number | null}): JSX.Element {
    const at = running ? members.findIndex((member) => member.number === running) : -1;
    return (
        <span className="pp-mq-stack">
            {members
                .map((member, index) => ({member, index}))
                .reverse()
                .map(({member, index}) => (
                    <span key={member.number} className={'pp-mq-member' + (index === at ? ' is-running' : '')}>
                        <span className="pp-mq-member-at pp-mono">↑{index + 1}</span>
                        <span className="pp-mq-member-title">
                            {member.title} <span className="pp-num">#{member.number}</span>
                        </span>
                        {at >= 0 && index === at && <span className="pp-pill is-queue-running">CI running</span>}
                        {at >= 0 && index > at && (
                            <span className="pp-pill">waits for #{members[index - 1].number}</span>
                        )}
                        {member.approved && (
                            <span className="pp-pill is-queue-queued">
                                {member.labelled ? 'labelled · approved' : 'approved'}
                            </span>
                        )}
                    </span>
                ))}
        </span>
    );
}

function HeadCard({head, context, now}: {head: QueueHead; context: Context; now: number}): JSX.Element {
    const owner = pullRequestSession(
        view.cachedAllProjects,
        context.projectPath,
        context.repository,
        head.members.map((member) => member.number),
    );
    const approved = approvedText(head);
    const estimate = estimateText(head.estimateMs);
    return (
        <div {...rowProps(context, head.number, 'pp-mq-head')}>
            <div className="pp-mq-line">
                <span className="pp-mq-badge" aria-label="First in the queue">
                    1
                </span>
                <span className="pp-mq-text">
                    <TitleLine title={head.title} number={head.number}>
                        {head.next && <span className="pp-pill is-queue-next">next</span>}
                    </TitleLine>
                    <span className="pp-mq-meta">
                        <span className="pp-mono">{head.headRef}</span>
                        {approved && <span>· {approved}</span>}
                        {owner && (
                            <span>
                                · <SessionLink sessionId={owner.sessionId} />
                            </span>
                        )}
                    </span>
                </span>
                <span className="pp-mq-eta">
                    {estimate && <span className="pp-mq-merges">merges in {estimate}</span>}
                    {head.runningSince !== null && (
                        <span className="pp-mq-since">CI for {minutesOf(now - head.runningSince)} min</span>
                    )}
                </span>
            </div>
            {head.stack && (
                <StackMembers
                    members={head.members}
                    running={head.stage.kind === 'checks' ? head.stage.waitsForCiOn : null}
                />
            )}
            <ol className="pp-mq-steps" aria-label="Where the head is">
                {headSteps(head.stage).map((step) => (
                    <li key={step.label} className={'pp-mq-step is-' + step.state}>
                        <span className="pp-mq-bar">
                            <span style={{width: Math.round(step.progress * 100) + '%'}} />
                        </span>
                        <span className="pp-mq-step-label">
                            {step.state === 'done' && <span className="pp-mq-tick">✓ </span>}
                            {step.label}
                        </span>
                        {step.detail && <span className="pp-mq-step-detail pp-mono">{step.detail}</span>}
                    </li>
                ))}
            </ol>
        </div>
    );
}

function EntryRow({entry, context}: {entry: QueuedEntry; context: Context}): JSX.Element {
    const held = entry.state.kind === 'held';
    const reviewer = reviewerOf(entry);
    const estimate = estimateText(entry.estimateMs);
    return (
        <div {...rowProps(context, entry.number, 'pp-mq-entry' + (held ? ' is-held' : ''))}>
            <span className="pp-mq-pos">{entry.position}</span>
            <span className="pp-mq-text">
                {entry.stack ? (
                    <TitleLine title={entry.title}>
                        <span className="pp-pill">stack · {entry.members.length} PRs · merges as one</span>
                        {entry.next && <span className="pp-pill is-queue-next">next</span>}
                    </TitleLine>
                ) : (
                    <TitleLine title={entry.title} number={entry.number}>
                        {entry.next && <span className="pp-pill is-queue-next">next</span>}
                    </TitleLine>
                )}
                {entry.stack && <StackMembers members={entry.members} />}
                <span className="pp-mq-sentence">{entry.sentence}</span>
                {reviewer && <NudgeLine pr={nudgePullRequest(entry)} reviewer={reviewer} context={context} />}
            </span>
            <span className="pp-mq-side">
                {reviewer ? (
                    <NudgeButton pr={nudgePullRequest(entry)} reviewer={reviewer} context={context} />
                ) : (
                    estimate && <span className="pp-mq-estimate">{estimate}</span>
                )}
            </span>
        </div>
    );
}

/** The PR a held entry's nudge is about: in a stack, the member the review is asked on. */
type NudgedPr = ReturnType<typeof nudgePullRequest>;

/** Under a held entry's sentence: how its nudge is going, when there is one. */
function NudgeLine({pr, reviewer, context}: {pr: NudgedPr; reviewer: string; context: Context}): JSX.Element | null {
    const status = nudgeStatus(context.errands, pr.number, reviewer);
    const action = context.actions[queueActionKey('nudge', pr.number, reviewer)];
    if (action?.phase === 'failed') return <span className="pp-mq-note is-failed">{action.reason}</span>;
    switch (status.kind) {
        case 'running':
            return (
                <span className="pp-mq-note is-running">
                    Nudging {reviewer} on Slack… {status.sessionId && <SessionLink sessionId={status.sessionId} />}
                </span>
            );
        case 'needs-you':
            return <span className="pp-mq-note is-needs-you">Needs you: the nudge stopped before it was sent</span>;
        case 'nudged':
            return <span className="pp-mq-note">nudged {clockTime(status.at)}</span>;
        case 'none':
            return null;
    }
}

function NudgeButton({pr, reviewer, context}: {pr: NudgedPr; reviewer: string; context: Context}): JSX.Element {
    const status = nudgeStatus(context.errands, pr.number, reviewer);
    const busy = context.actions[queueActionKey('nudge', pr.number, reviewer)]?.phase === 'busy';
    switch (status.kind) {
        case 'running':
            return <span className="pp-pill is-queue-running">running</span>;
        case 'needs-you':
            return status.sessionId ? (
                <RowButton accent onClick={() => openProjectSession(status.sessionId!)}>
                    Open session
                </RowButton>
            ) : (
                <span className="pp-pill is-queue-held">needs you</span>
            );
        case 'nudged':
            return <RowButton disabled>Nudged</RowButton>;
        case 'none':
            return (
                <RowButton
                    disabled={busy}
                    onClick={() => void nudgeReviewer(context.projectPath, context.repository, pr, reviewer)}>
                    {busy ? 'Nudging…' : 'Nudge ' + reviewer}
                </RowButton>
            );
    }
}

function FailedRow({entry, context}: {entry: FailedEntry; context: Context}): JSX.Element {
    const fix = fixStatus(
        context.errands,
        entry.members.map((member) => member.number),
    );
    const fixAction = context.actions[queueActionKey('fix', entry.number)];
    const retryAction = context.actions[queueActionKey('retry', entry.number)];
    return (
        <div {...rowProps(context, entry.number, 'pp-mq-entry is-failed')}>
            <span className="pp-mq-pos">!</span>
            <span className="pp-mq-text">
                <TitleLine title={entry.title} number={entry.number} />
                <span className="pp-mq-reason">
                    <span className="pp-mq-failure">
                        {failureLabel(entry.kind)}
                        {entry.failedMember !== null && ` on #${entry.failedMember}`}
                    </span>
                    {entry.failingCheck && (
                        <>
                            {' · '}
                            <span className="pp-mono">{entry.failingCheck}</span>
                        </>
                    )}
                    {' · '}
                    {entry.reason}
                </span>
                <span className="pp-mq-rejoins">{entry.rejoins}</span>
                {fix.kind === 'running' && (
                    <span className="pp-mq-note is-running">
                        Fixing in {fix.sessionId ? <SessionLink sessionId={fix.sessionId} /> : 'a new session'}
                    </span>
                )}
                {fix.kind === 'needs-you' && (
                    <span className="pp-mq-note is-needs-you">Needs you: the fix stopped without pushing</span>
                )}
                {fix.kind === 'none' && fixAction?.phase === 'sent' && (
                    <span className="pp-mq-note is-running">
                        Sent to its own <SessionLink sessionId={fixAction.sessionId} />
                    </span>
                )}
                {fixAction?.phase === 'note' && <span className="pp-mq-note">{fixAction.text}</span>}
                {fixAction?.phase === 'failed' && <span className="pp-mq-note is-failed">{fixAction.reason}</span>}
                {retryAction?.phase === 'failed' && <span className="pp-mq-note is-failed">{retryAction.reason}</span>}
            </span>
            <span className="pp-mq-side">
                {fix.kind === 'running' ? (
                    <span className="pp-pill is-queue-running">running</span>
                ) : fix.kind === 'needs-you' && fix.sessionId ? (
                    <RowButton accent onClick={() => openProjectSession(fix.sessionId!)}>
                        Open session
                    </RowButton>
                ) : (
                    <RowButton
                        accent
                        disabled={fixAction?.phase === 'busy'}
                        onClick={() => void fixInSession(context.projectPath, context.repository, entry)}>
                        {fixAction?.phase === 'busy' ? 'Starting…' : 'Fix in session'}
                    </RowButton>
                )}
                <RowButton
                    disabled={retryAction?.phase === 'busy'}
                    onClick={() => void retryQueueEntry(context.repository, entry.number)}>
                    {retryAction?.phase === 'busy' ? 'Retrying…' : 'Retry'}
                </RowButton>
            </span>
        </div>
    );
}

function UnknownRow({entry, context}: {entry: UnknownEntry; context: Context}): JSX.Element {
    return (
        <div {...rowProps(context, entry.number, 'pp-mq-entry is-unknown')}>
            <span className="pp-mq-pos">?</span>
            <span className="pp-mq-text">
                <TitleLine title={entry.title} number={entry.number} />
                <span className="pp-mq-sentence">{entry.text}</span>
            </span>
        </div>
    );
}
