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
 * Retry; a landed one's are the Merge manager's fix errand instead (Open
 * errand, or Open and Try again once it gave up, #437); then the PRs the
 * queue could not be read for, in its own words.
 * A queue with failed entries and nothing else that can move says it is
 * stalled, in red. Estimates from place 3 on are rough: rounded to 5 minutes
 * and faded.
 *
 * Under it, the CI job queue: the repository's running and queued jobs on
 * self-hosted runners, by runner pool, each queued one with its expected
 * runner wait and, when queued jobs are ahead of it, Bump.
 *
 * A Switchboard-lane repository (#441) gets the section too, from the Merge
 * manager's lane once anything in it is landed: its lane label, the counts
 * and the estimate in the heading, the head's three steps (Updated on the
 * trunk → Checks → Merge), and each landed PR with its stage pill. In a
 * queue lane, the user's landed PRs carry the same stage pills.
 *
 * Once one of the user's PRs is landed here, the heading offers Open in Merge
 * manager → (#439): the page, with it selected.
 *
 * Each entry is a cursor row (↵, or a click, opens its PR in the browser). What it
 * says is `merge-queue-view`; what its buttons do, `merge-queue-actions`.
 */
import type {JSX, MouseEvent, ReactNode} from 'react';
import {useStore} from '../use-store';
import {sessionMap, view} from '../../state/session-store';
import {sessionDisplayName} from '../../state/session-list-layout';
import {queueActionKey, type QueueActionState} from '../../state/project-page-slice';
import type {EntryMember, FailedEntry, QueueHead, QueuedEntry, UnknownEntry} from '../../../domain/project/merge-queue';
import {nudgePullRequest, reviewerOf, type QueueErrandView} from '../../../domain/project/queue-errands';
import type {IssueKey} from '../../../domain/plan/model';
import {cursorId} from './page-rows';
import {openProjectSession, openPullRequest} from './actions';
import {
    bumpCiJob,
    fixInSession,
    openCiJob,
    nudgeReviewer,
    retryQueueEntry,
    tryAgainErrand,
} from './merge-queue-actions';
import {
    approvedText,
    clockTime,
    countsText,
    expectedText,
    failureLabel,
    fixStatus,
    headSteps,
    isEmptyQueue,
    jobRowView,
    landedFixStatus,
    laneCountsText,
    laneEstimates,
    laneHeadSteps,
    mergeQueueOf,
    minutesOf,
    nudgeStatus,
    poolBusyText,
    STALLED_TEXT,
    switchboardLaneOf,
    type ExpectedText,
    type LandedFixStatus,
    type SwitchboardLaneSection,
} from './merge-queue-view';
import type {LandedView, LaneView, MergeManagerState} from '../../../domain/merge-manager/model';
import {openMergeManager} from '../merge-manager/page-actions';
import {findLanded, landedWords, type StageWords} from '../../../domain/merge-manager/stage-words';
import {bumpedRuns, type JobPool, type JobQueueRow} from '../../../domain/project/ci-job-queue';
import {pullRequestSession} from './project-sessions';

interface Context {
    readonly projectPath: string;
    readonly repository: string;
    readonly cursor: string | null;
    readonly errands: readonly QueueErrandView[];
    readonly actions: Readonly<Record<string, QueueActionState>>;
    readonly merge: MergeManagerState;
}

export function MergeQueueSection({projectPath}: {projectPath: string}): JSX.Element | null {
    const page = useStore((state) => state.projectPage);
    // The head's owning session is read from the cached projects, which change with the list's redraws.
    useStore((state) => state.sessionList.revision);
    const now = useStore((state) => state.sessionList.now) || Date.now();
    const merge = useStore((state) => state.mergeManager.state);
    const queue = mergeQueueOf(page, projectPath);
    const repository = page.overview?.repository ?? null;
    if (!queue) {
        const lane = switchboardLaneOf(page, projectPath, merge);
        return lane ? <SwitchboardLane lane={lane} cursor={page.cursor} /> : null;
    }
    if (!repository) return null;

    const context: Context = {
        projectPath,
        repository,
        cursor: page.cursor,
        errands: page.queueErrands?.repository === repository ? page.queueErrands.errands : [],
        actions: page.queueActions,
        merge,
    };
    const counts = countsText(queue.counts);
    const clears = expectedText(queue.clearsInMs, queue.clearsAtPlace ?? 1);
    const jobs = page.ciJobQueue?.repository === repository ? page.ciJobQueue.answer : null;
    const headNumbers = queue.head ? queue.head.members.map((member) => member.number) : [];

    return (
        <section className="pp-section pp-mq" aria-labelledby="pp-mq-heading">
            <div className="pp-section-head">
                <h2 id="pp-mq-heading">Merge queue</h2>
                {counts && <span className="pp-count">{counts}</span>}
                {queue.stalled && <span className="pp-mq-stalled">{STALLED_TEXT}</span>}
                {clears && (
                    <span className={'pp-mq-clears' + (clears.rough ? ' is-rough' : '')}>
                        Clears in about <strong>{clears.text.slice(1)}</strong>
                    </span>
                )}
                <OpenInMergeManager
                    lane={merge.lanes.find((lane) => lane.repository.toLowerCase() === repository.toLowerCase())}
                />
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
                {jobs?.ok && jobs.pools.length > 0 && (
                    <CiJobQueue
                        pools={jobs.pools}
                        notes={jobs.notes}
                        headNumbers={headNumbers}
                        context={context}
                        now={now}
                    />
                )}
            </div>
        </section>
    );
}

// ── Pieces ──

/**
 * "Open in Merge manager →" (#439), once one of the user's PRs is landed in
 * this repository: the page, with the first of them selected.
 */
function OpenInMergeManager({lane}: {lane: LaneView | undefined}): JSX.Element | null {
    const first = lane?.pullRequests.find((pr) => pr.stage.kind !== 'merged') ?? lane?.pullRequests[0];
    if (!first) return null;
    return (
        <button type="button" className="pp-link pp-mq-open" onClick={() => openMergeManager(first.key)}>
            Open in Merge manager →
        </button>
    );
}

/** A stage, as a pill in the words every place shares (#441). */
function StagePill({words}: {words: StageWords}): JSX.Element {
    return (
        <span className={'pp-stage is-landed-' + words.kind} title={words.title}>
            <i aria-hidden="true" />
            {words.label}
        </span>
    );
}

/** A queue entry's stage pill, when it is one of the user's landed PRs; nothing otherwise. */
function LandedStage({context, number}: {context: Context; number: number}): JSX.Element | null {
    const found = findLanded(context.merge, context.repository, number);
    return found ? <StagePill words={landedWords(found)} /> : null;
}

/** A Switchboard lane's section (#441): the Merge manager's landed PRs in this repository. */
function SwitchboardLane({lane, cursor}: {lane: SwitchboardLaneSection; cursor: string | null}): JSX.Element {
    const counts = laneCountsText(lane.rows);
    const estimates = laneEstimates(lane.rows, lane.runMs);
    const last = Math.max(0, ...estimates.keys());
    const clears = last ? expectedText(estimates.get(last)!, last) : null;
    const rowProps = (number: number, className: string) => {
        const key: IssueKey = {repository: lane.repository, number};
        const id = cursorId.queueEntry(key);
        return {
            className: className + (cursor === id ? ' is-cursor' : ''),
            'data-cursor-id': id,
            onClick: () => openPullRequest(key),
        };
    };
    return (
        <section className="pp-section pp-mq" aria-labelledby="pp-mq-heading">
            <div className="pp-section-head">
                <h2 id="pp-mq-heading">Merge queue</h2>
                <span className="pp-mq-lane">Switchboard lane</span>
                {counts && <span className="pp-count">{counts}</span>}
                {clears && (
                    <span className={'pp-mq-clears' + (clears.rough ? ' is-rough' : '')}>
                        Clears in about <strong>{clears.text.slice(1)}</strong>
                    </span>
                )}
                <OpenInMergeManager lane={lane.lane} />
            </div>
            <div className="pp-card pp-mq-card">
                {lane.rows.map((pr) => {
                    const words = landedWords({pullRequest: pr, lane: lane.lane});
                    const estimate = pr.place === null ? null : expectedText(estimates.get(pr.place) ?? null, pr.place);
                    const head = pr.stage.kind === 'head' ? pr.stage : null;
                    const line = (
                        <>
                            <span className={head ? 'pp-mq-badge' : 'pp-mq-pos'}>{pr.place ?? '·'}</span>
                            <span className="pp-mq-text">
                                <TitleLine title={pr.title} number={pr.number}>
                                    {words.flag && <span className="pp-stage-flag">· {words.flag}</span>}
                                </TitleLine>
                                <span className="pp-mq-meta">
                                    <span className="pp-mono">{pr.headRef}</span>
                                </span>
                            </span>
                            <span className="pp-mq-side">
                                {estimate && <Estimate estimate={estimate} />}
                                <StagePill words={words} />
                                <ErrandButtons repository={lane.repository} pr={pr} />
                            </span>
                        </>
                    );
                    if (!head) {
                        return (
                            <div
                                key={pr.key}
                                {...rowProps(pr.number, 'pp-mq-entry' + (pr.place === null ? ' is-held' : ''))}>
                                {line}
                            </div>
                        );
                    }
                    return (
                        <div key={pr.key} {...rowProps(pr.number, 'pp-mq-head')}>
                            <div className="pp-mq-line">{line}</div>
                            <ol className="pp-mq-steps is-lane" aria-label="Where the head is">
                                {laneHeadSteps(head.step).map((step) => (
                                    <li key={step.label} className={'pp-mq-step is-' + step.state}>
                                        <span className="pp-mq-bar">
                                            <span style={{width: Math.round(step.progress * 100) + '%'}} />
                                        </span>
                                        <span className="pp-mq-step-label">
                                            {step.state === 'done' && <span className="pp-mq-tick">✓ </span>}
                                            {step.label}
                                        </span>
                                    </li>
                                ))}
                            </ol>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

/**
 * A Switchboard lane row's fix errand (#437): Open errand while one works on
 * it, Open and Try again once it gave up; nothing otherwise.
 */
function ErrandButtons({repository, pr}: {repository: string; pr: LandedView}): JSX.Element | null {
    const tryAgain = useStore((state) => state.projectPage.queueActions[queueActionKey('try-again', pr.number)]);
    const stopped = pr.stage.kind === 'needsYou' && pr.stage.reason.kind === 'errand-stopped';
    if (pr.stage.kind === 'fixing') {
        return pr.errand ? (
            <RowButton accent onClick={() => openProjectSession(pr.errand!)}>
                Open errand
            </RowButton>
        ) : null;
    }
    if (!stopped) return null;
    return (
        <>
            {pr.errand && (
                <RowButton accent onClick={() => openProjectSession(pr.errand!)}>
                    Open
                </RowButton>
            )}
            <RowButton disabled={tryAgain?.phase === 'busy'} onClick={() => void tryAgainErrand(repository, pr.number)}>
                {tryAgain?.phase === 'busy' ? 'Starting…' : 'Try again'}
            </RowButton>
        </>
    );
}

/** The props a cursor row carries: its id, its class, and a click that opens its PR. */
function rowProps(context: Context, number: number, className: string) {
    const key: IssueKey = {repository: context.repository, number};
    const id = cursorId.queueEntry(key);
    return {
        className: className + (context.cursor === id ? ' is-cursor' : ''),
        'data-cursor-id': id,
        onClick: () => openPullRequest(key),
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
    const estimate = expectedText(head.estimateMs, 1);
    return (
        <div {...rowProps(context, head.number, 'pp-mq-head')}>
            <div className="pp-mq-line">
                <span className="pp-mq-badge" aria-label="First in the queue">
                    1
                </span>
                <span className="pp-mq-text">
                    <TitleLine title={head.title} number={head.number}>
                        {head.next && <span className="pp-pill is-queue-next">next</span>}
                        <LandedStage context={context} number={head.number} />
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
                    {estimate && <span className="pp-mq-merges">merges in {estimate.text}</span>}
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
    const estimate = expectedText(entry.estimateMs, entry.position);
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
                        <LandedStage context={context} number={entry.number} />
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
                    estimate && <Estimate estimate={estimate} />
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
    const landed = landedFixStatus(
        context.merge,
        context.repository,
        entry.members.map((member) => member.number),
    );
    if (landed) return <LandedFailedRow entry={entry} landed={landed} context={context} />;
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
                <TitleLine title={entry.title} number={entry.number}>
                    <LandedStage context={context} number={entry.number} />
                </TitleLine>
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

/** A failed entry whose PR is landed: the Merge manager's fix errand has it (#437). */
function LandedFailedRow({
    entry,
    landed,
    context,
}: {
    entry: FailedEntry;
    landed: LandedFixStatus;
    context: Context;
}): JSX.Element {
    const tryAgain = context.actions[queueActionKey('try-again', landed.number)];
    return (
        <div {...rowProps(context, entry.number, 'pp-mq-entry is-failed')}>
            <span className="pp-mq-pos">!</span>
            <span className="pp-mq-text">
                <TitleLine title={entry.title} number={entry.number}>
                    <LandedStage context={context} number={landed.number} />
                </TitleLine>
                <span className="pp-mq-reason">
                    <span className="pp-mq-failure">{failureLabel(entry.kind)}</span>
                    {' · '}
                    {entry.reason}
                </span>
                {landed.kind === 'fixing' ? (
                    <span className="pp-mq-note is-running">
                        {landed.sessionId ? (
                            <>
                                A fix errand is on it in <SessionLink sessionId={landed.sessionId} />
                            </>
                        ) : (
                            'A fix errand starts by itself'
                        )}
                    </span>
                ) : (
                    <span className="pp-mq-note is-needs-you">Needs you: the fix errand stopped without finishing</span>
                )}
                {tryAgain?.phase === 'failed' && <span className="pp-mq-note is-failed">{tryAgain.reason}</span>}
            </span>
            <span className="pp-mq-side">
                {landed.kind === 'fixing' && landed.sessionId && (
                    <RowButton accent onClick={() => openProjectSession(landed.sessionId!)}>
                        Open errand
                    </RowButton>
                )}
                {landed.kind === 'needs-you' && landed.sessionId && (
                    <RowButton accent onClick={() => openProjectSession(landed.sessionId!)}>
                        Open
                    </RowButton>
                )}
                {landed.kind === 'needs-you' && (
                    <RowButton
                        disabled={tryAgain?.phase === 'busy'}
                        onClick={() => void tryAgainErrand(context.repository, landed.number)}>
                        {tryAgain?.phase === 'busy' ? 'Starting…' : 'Try again'}
                    </RowButton>
                )}
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

/** An entry's expected merge time; faded when rough. */
function Estimate({estimate}: {estimate: ExpectedText}): JSX.Element {
    return (
        <span
            className={'pp-mq-estimate' + (estimate.rough ? ' is-rough' : '')}
            title={estimate.rough ? 'A rough guess this far back: rounded to 5 minutes' : undefined}>
            {estimate.text}
        </span>
    );
}

// ── The CI job queue ──

function CiJobQueue({
    pools,
    notes,
    headNumbers,
    context,
    now,
}: {
    pools: readonly JobPool[];
    notes: Readonly<Record<number, string>>;
    headNumbers: readonly number[];
    context: Context;
    now: number;
}): JSX.Element {
    return (
        <>
            <div className="pp-mq-subhead">CI job queue</div>
            <div className="pp-mq-group pp-mq-jobs">
                {pools.map((pool) => (
                    <div key={pool.name} className="pp-mq-pool">
                        <div className="pp-mq-pool-head">
                            <span className="pp-mq-pool-name pp-mono">{pool.name || 'self-hosted'}</span>
                            <span className="pp-mq-pool-busy">{poolBusyText(pool)}</span>
                        </div>
                        {pool.rows.length === 0 && <div className="pp-mq-job is-quiet">No jobs</div>}
                        {pool.rows.map((row) => (
                            <JobRow
                                key={row.kind === 'job' ? 'job:' + row.job.id : 'other:' + row.runner}
                                row={row}
                                pools={pools}
                                notes={notes}
                                headNumbers={headNumbers}
                                context={context}
                                now={now}
                            />
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
}

function JobRow({
    row,
    pools,
    notes,
    headNumbers,
    context,
    now,
}: {
    row: JobQueueRow;
    pools: readonly JobPool[];
    notes: Readonly<Record<number, string>>;
    headNumbers: readonly number[];
    context: Context;
    now: number;
}): JSX.Element {
    const view = jobRowView(row, now);
    const job = row.kind === 'job' ? row.job : null;
    const state = job === null ? 'is-other' : job.status === 'running' ? 'is-running' : 'is-queued';
    const canBump = job !== null && bumpedRuns(pools, job.id, headNumbers).length > 0;
    const action = job ? context.actions[queueActionKey('bump', job.id)] : undefined;
    const note = job ? notes[job.id] : undefined;
    return (
        <div className={'pp-mq-job ' + state}>
            <span className="pp-mq-job-dot" aria-hidden="true" />
            <span className="pp-mq-text">
                <span className="pp-mq-title-line">
                    {job?.url ? (
                        <button
                            type="button"
                            className="pp-inline-link pp-mq-job-name"
                            onClick={() => openCiJob(job.url)}>
                            {view.title}
                        </button>
                    ) : (
                        <span className="pp-mq-job-name">{view.title}</span>
                    )}
                    {view.on && <span className="pp-mq-job-on">{view.on}</span>}
                </span>
                <span className="pp-mq-sentence">
                    <span className="pp-mono">{view.where}</span>
                    {view.wait && ' · ' + view.wait}
                </span>
                {action?.phase === 'note' && <span className="pp-mq-note">{action.text}</span>}
                {action?.phase === 'failed' && <span className="pp-mq-note is-failed">{action.reason}</span>}
                {note && <span className="pp-mq-note is-failed">{note}</span>}
            </span>
            <span className="pp-mq-side">
                {view.times && <span className="pp-mq-estimate">{view.times}</span>}
                {canBump && job && (
                    <RowButton
                        disabled={action?.phase === 'busy'}
                        onClick={() => void bumpCiJob(context.repository, pools, job, headNumbers)}>
                        {action?.phase === 'busy' ? 'Bumping…' : 'Bump'}
                    </RowButton>
                )}
            </span>
        </div>
    );
}
