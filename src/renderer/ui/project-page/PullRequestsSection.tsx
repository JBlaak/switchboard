/**
 * The project page's Pull requests section (#175), first, over Plans & issues:
 * the PRs grouped by what they wait on (Needs you, Waiting on CI, Waiting on
 * review, Ready to merge, Merged or closed today; `pull-request-wait`), each
 * as a two-line row with its state, title, number and head branch, then an
 * "in #n" chip when it closes an issue in a plan (a click expands that plan),
 * its checks and its open point. Drafts are dimmed. Show merged adds the
 * older merged ones last. A click, or ↵, opens it on GitHub.
 * In a repository with a merge queue (#315), an open PR's row carries its
 * queue pill ("merging · 1st", "queued · 2nd", "queue failed", "kept
 * rebased"), and an approved one that isn't queued offers + Queue.
 * Your own open PRs offer Land it (#436) instead, disabled on a draft, and
 * show their landed stage once landed; teammates' rows never get it.
 *
 * Which rows are on screen is `page-rows`, shared with the page's keys. Until
 * the first answer the section shimmers; when GitHub had nothing to say it is
 * left out, and the page says why in its place (`GitHubMessage`).
 */
import type {JSX, MouseEvent} from 'react';
import {useStore} from '../use-store';
import {dispatch} from '../../state/app-store';
import type {IssueKey} from '../../../domain/plan/model';
import {checksPill, cursorId, pullRequestsViewOf, type PullRequestOnScreen} from './page-rows';
import {openPullRequest, revealPlan} from './actions';
import {SectionSkeleton} from './SectionSkeleton';
import {optInToQueue} from './merge-queue-actions';
import {queueActionKey} from '../../state/project-page-slice';
import type {QueuePill} from '../../../domain/project/merge-queue';
import {LandIt} from '../merge-manager/LandIt';
import {landOffer, type LandCandidate} from '../../../domain/merge-manager/land-it';

export function PullRequestsSection({projectPath}: {projectPath: string}): JSX.Element | null {
    const page = useStore((state) => state.projectPage);
    const now = useStore((state) => state.sessionList.now) || Date.now();
    const answered = page.overview?.projectPath === projectPath ? page.overview : null;
    const groups = pullRequestsViewOf(page, projectPath, now);
    if (answered && !groups) return null;

    const github = answered?.github?.ok ? answered.github : null;
    const open = github ? github.pullRequests.filter((row) => row.pullRequest.state === 'open').length : 0;
    const merged =
        github && page.showMerged ? github.pullRequests.filter((row) => row.pullRequest.state === 'merged').length : 0;

    return (
        <section className="pp-section pp-prs" aria-labelledby="pp-prs-heading">
            <div className="pp-section-head">
                <h2 id="pp-prs-heading">Pull requests</h2>
                {github && (
                    <span className="pp-count">
                        {open} open{merged ? ' · ' + merged + ' merged' : ''}
                    </span>
                )}
                <button type="button" className="pp-link" onClick={() => dispatch({type: 'projectShowMergedToggled'})}>
                    {page.showMerged ? 'Hide merged' : 'Show merged'}
                </button>
            </div>
            <div className="pp-card" aria-busy={!groups}>
                {!groups && <SectionSkeleton label="Loading pull requests" />}
                {groups && groups.length === 0 && (
                    <div className="pp-quiet">
                        {page.filter ? 'No pull request here matches.' : 'No open pull requests.'}
                    </div>
                )}
                {groups?.map((group) => (
                    <div
                        key={group.group}
                        className="pp-pr-group"
                        role="group"
                        aria-labelledby={'pp-prs-' + group.group}>
                        <div className="pp-subhead" id={'pp-prs-' + group.group}>
                            {group.title} <span className="pp-pr-group-count">{group.rows.length}</span>
                        </div>
                        {group.rows.map((row) => (
                            <PullRequestRow
                                key={cursorId.pullRequest(row.pullRequest)}
                                row={row}
                                cursor={page.cursor}
                                queuePill={
                                    row.pullRequest.state === 'open'
                                        ? (github?.mergeQueue?.pills[row.pullRequest.number] ?? null)
                                        : null
                                }
                            />
                        ))}
                    </div>
                ))}
            </div>
        </section>
    );
}

/** One PR: its state, title, number and head branch; its plan chip, queue pill, checks and open point. */
function PullRequestRow({
    row,
    cursor,
    queuePill,
}: {
    row: PullRequestOnScreen;
    cursor: string | null;
    queuePill: QueuePill | null;
}): JSX.Element {
    const {pullRequest: pr, plan, wait} = row;
    const key: IssueKey = {repository: pr.repository, number: pr.number};
    const id = cursorId.pullRequest(key);
    const state = pr.state !== 'open' ? pr.state : pr.draft ? 'draft' : 'open';
    const checks = pr.state === 'open' ? checksPill(pr.checks) : null;
    const land: LandCandidate = {repository: pr.repository, number: pr.number, state, mine: pr.mine};
    const lanes = useStore((s) => s.mergeManager.state);
    const offer = landOffer(land, lanes);
    // Land it takes + Queue's place (in a queue lane it adds the same label), and a landed PR's stage the queue's.
    const showQueuePill = !!queuePill && (!offer || (offer.kind !== 'landed' && queuePill.kind !== 'queueable'));
    const reveal = (e: MouseEvent): void => {
        e.stopPropagation();
        if (plan) revealPlan(plan);
    };
    return (
        <div
            className={'pp-pr is-' + state + (cursor === id ? ' is-cursor' : '')}
            data-cursor-id={id}
            onClick={() => openPullRequest(key)}>
            <PullRequestIcon state={state} />
            <span className="pp-row-text">
                <span className="pp-pr-line">
                    <span className="pp-pr-title">{pr.title}</span>
                    <span className="pp-num">#{pr.number}</span>
                </span>
                <span className="pp-row-meta pp-mono">{pr.headRef}</span>
            </span>
            <span className="pp-right">
                {plan && (
                    <button
                        type="button"
                        className="pp-pill pp-chip"
                        title={'Show plan #' + plan.number}
                        onClick={reveal}>
                        in #{plan.number}
                    </button>
                )}
                {showQueuePill && queuePill && <QueuePillOf pill={queuePill} pr={key} />}
                {offer && <LandIt pr={land} size="sm" />}
                {checks && <span className={'pp-pill is-checks-' + checks.tone}>{checks.text}</span>}
                {wait.openPoint && (
                    <span className={'pp-open-point is-' + wait.group} title={wait.openPoint}>
                        {wait.openPoint}
                    </span>
                )}
            </span>
        </div>
    );
}

/** A PR's place in the merge queue (#315); + Queue on an approved one that isn't in it. */
function QueuePillOf({pill, pr}: {pill: QueuePill; pr: IssueKey}): JSX.Element {
    const action = useStore((state) => state.projectPage.queueActions[queueActionKey('opt-in', pr.number)]);
    if (pill.kind !== 'queueable') {
        return (
            <span className={'pp-pill is-queue-' + pill.kind} title={pill.title}>
                {pill.text}
            </span>
        );
    }
    return (
        <button
            type="button"
            className="pp-pill pp-chip is-queue-queueable"
            title={action?.phase === 'failed' ? action.reason : pill.title}
            disabled={action?.phase === 'busy'}
            onClick={(e: MouseEvent) => {
                e.stopPropagation();
                void optInToQueue(pr.repository, pr.number);
            }}>
            {action?.phase === 'busy' ? 'Queuing…' : pill.text}
        </button>
    );
}

function PullRequestIcon({state}: {state: 'open' | 'draft' | 'merged' | 'closed'}): JSX.Element {
    const label = {open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed'}[state];
    return (
        <svg
            className={'pp-state is-pr-' + state}
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            role="img"
            aria-label={label}>
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="18" r="2.5" />
            {state === 'merged' ? (
                <path d="M6 8.5v7M8.5 6H12a6 6 0 0 1 6 6v3.5" />
            ) : (
                <path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4" />
            )}
        </svg>
    );
}
