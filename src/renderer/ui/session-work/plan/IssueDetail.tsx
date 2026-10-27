/**
 * An issue's detail (D4): its number, title, state and level, its summary,
 * what it needs and what it unlocks (each a step along the chain), its PRs,
 * its acceptance criteria, and the actions. ↑/↓ step through the issues in
 * level order; the page hears those keys (see `plan/load`).
 *
 * Open issue and Open PR always show. Jump to session and Start session come
 * through `IssueActions` (#125, wired in `issue-actions`), and show nothing
 * without them. A Locked issue asks before it starts, saying what it stacks
 * on (A3); a warning or a refusal shows inline. A refusal because the
 * issue's branch exists already offers what to do with it: continue work on
 * it, open the session that worked on it, or delete its worktree and branch
 * (after a second ask) and start again.
 */
import { useState, type JSX } from 'react';
import { issueKeyString, sameIssue } from '../../../../domain/plan/model';
import { startBase, type ExistingIssueBranch } from '../../../../domain/plan/issue-session';
import type { IssueKey, Plan, PlanIssue, PlanLayout } from '../../../../domain/plan/model';
import {
  isHolding, issueIn, issueUrl, mainPullRequest, pullRequestUrl, shortRef, shortTitle, STATE_LABEL,
} from './describe';
import { blockersInPlan } from './geometry';
import type { IssueActions, PlanHandlers } from './types';

export function IssueDetail(
  { plan, layout, issue, on, issueActions }:
  { plan: Plan; layout: PlanLayout; issue: PlanIssue; on: PlanHandlers; issueActions?: IssueActions },
): JSX.Element {
  const state = layout.stateOf(issue);
  const level = layout.levelOf(issue);
  const needs = blockersInPlan(plan, issue);
  const ghosts = layout.ghosts(issue);
  const unlocks = layout.unlocks(issue);
  const ticked = issue.acceptance.filter(item => item.done).length;
  const pr = mainPullRequest(issue);
  const session = issueActions?.sessionFor?.(issue) ?? null;
  const canStart = !!issueActions?.startSession && (state === 'ready' || state === 'locked') && !session;
  const start = issueActions?.start && sameIssue(issueActions.start.issue, issue) ? issueActions.start : null;
  // Its options replace Start session, which would only be refused again.
  const existing = start?.phase === 'answered' && !start.result.ok ? start.result.existing ?? null : null;

  const pill = (key: IssueKey) => {
    const other = issueIn(plan, key);
    if (!other) return null;
    return (
      <button
        key={issueKeyString(key)}
        type="button"
        className={'pv-ref is-' + layout.stateOf(other)}
        title={other.title}
        onClick={() => on.select(other)}
      >
        <span className="pv-dot" aria-hidden="true" />
        {shortRef(plan, other) + ' ' + shortTitle(other.title)}
      </button>
    );
  };

  return (
    <aside className="pv-detail" aria-label="Issue detail">
      <div className="pv-detail-top">
        <span className="pv-num">{issue.repository + '#' + issue.number}</span>
        <span className="pv-detail-gap" />
        <button type="button" className="pv-pill" onClick={() => on.step(-1)} aria-label="Previous issue">↑</button>
        <button type="button" className="pv-pill" onClick={() => on.step(1)} aria-label="Next issue">↓</button>
        <button type="button" className="pv-pill" onClick={() => on.select(null)} aria-label="Close detail">
          Close <kbd className="sw-kbd">esc</kbd>
        </button>
      </div>
      <h2 className={'pv-detail-title' + (state === 'not-planned' ? ' is-struck' : '')}>{issue.title}</h2>
      <div className="pv-chips">
        <span className={'pv-chip is-' + state}><span className="pv-dot" aria-hidden="true" />{STATE_LABEL[state]}</span>
        <span className="pv-pill is-static">{'Level ' + level}</span>
        {isHolding(plan, layout, issue) && (
          <span className="pv-pill is-static is-holding">{'Holding the plan at Level ' + level}</span>
        )}
      </div>
      {issue.summary && <p className="pv-summary">{issue.summary}</p>}

      <section className="pv-section">
        <h3 className="pv-h3">Needs</h3>
        <div className="pv-refs">
          {needs.map(pill)}
          {ghosts.map(ghost => (
            <button
              key={issueKeyString(ghost)}
              type="button"
              className={'pv-ref is-ghost is-' + layout.stateOf(ghost)}
              title={ghost.title + ' · outside this plan'}
              onClick={() => on.open(issueUrl(ghost))}
            >
              <span className="pv-dot" aria-hidden="true" />
              {shortRef(plan, ghost) + ' ' + shortTitle(ghost.title)}
            </button>
          ))}
          {needs.length + ghosts.length === 0 && <span className="pv-none">Nothing. This is where the plan starts.</span>}
        </div>
      </section>

      <section className="pv-section">
        <h3 className="pv-h3">Unlocks</h3>
        <div className="pv-refs">
          {unlocks.map(pill)}
          {unlocks.length === 0 && <span className="pv-none">Nothing waits on this one.</span>}
        </div>
      </section>

      <section className="pv-section">
        <h3 className="pv-h3">Pull requests</h3>
        {issue.pullRequests.map(request => {
          const url = pullRequestUrl(issue.repository, request.number);
          return (
            <a
              key={request.number}
              className={'pv-pr is-' + (request.draft && request.state === 'open' ? 'draft' : request.state)}
              href={url}
              onClick={(e) => { e.preventDefault(); on.open(url); }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" />
                <path d="M4 5v6M12 11V7a2 2 0 0 0-2-2H8" />
              </svg>
              <span className="pv-num">{'#' + request.number}</span>
              <span className="pv-pr-state">{request.draft && request.state === 'open' ? 'draft' : request.state}</span>
              <span className="pv-add">{'+' + request.additions}</span>
              <span className="pv-del">{'−' + request.deletions}</span>
            </a>
          );
        })}
        {issue.pullRequests.length === 0 && (
          <span className="pv-none">
            {issue.state === 'closed' ? `Closed, but no PR says “Closes #${issue.number}”.` : 'No PR yet.'}
          </span>
        )}
      </section>

      {issue.acceptance.length > 0 && (
        <section className="pv-section">
          <h3 className="pv-h3">{`Acceptance criteria · ${ticked} of ${issue.acceptance.length} ticked on GitHub`}</h3>
          <ul className="pv-criteria">
            {issue.acceptance.map((item, i) => (
              <li key={i} className={item.done ? 'is-done' : undefined}>
                <span className="pv-box" aria-hidden="true" />
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {start?.phase === 'confirm' && (
        <div className="pv-confirm" role="group" aria-label="Start early">
          <span>{stackLine(plan, issue)}</span>
          <div className="pv-confirm-buttons">
            <button type="button" className="sw-btn is-primary" onClick={() => issueActions!.confirmStart?.(plan)}>
              {'Start #' + issue.number + ' early'}
            </button>
            <button type="button" className="sw-btn" onClick={() => issueActions!.cancelStart?.()}>Cancel</button>
          </div>
        </div>
      )}
      {existing && (
        <ExistingBranch key={issueKeyString(issue)} plan={plan} issue={issue} existing={existing} issueActions={issueActions!} />
      )}
      {start?.phase === 'answered' && !start.result.ok && !existing && (
        <div className="pv-inline is-error" role="alert">{start.result.reason}</div>
      )}
      {start?.phase === 'answered' && start.result.ok && start.result.warning && (
        <div className="pv-inline is-warning" role="status">{start.result.warning}</div>
      )}

      <div className="pv-actions">
        {session && issueActions?.jumpToSession && (
          <button type="button" className="sw-btn is-primary" onClick={() => issueActions.jumpToSession!(session.id)}>
            {'Jump to ' + session.name}
          </button>
        )}
        {canStart && start?.phase !== 'confirm' && !existing && (
          <button
            type="button"
            className="sw-btn is-primary"
            aria-disabled={start?.phase === 'starting'}
            onClick={() => { if (start?.phase !== 'starting') issueActions!.startSession!(issue, plan); }}
          >
            {start?.phase === 'starting' ? 'Starting…' : 'Start session on #' + issue.number}
          </button>
        )}
        <button type="button" className="sw-btn" onClick={() => on.open(issueUrl(issue))}>Open issue</button>
        {pr && (
          <button type="button" className="sw-btn" onClick={() => on.open(pullRequestUrl(issue.repository, pr.number))}>
            {'Open PR #' + pr.number}
          </button>
        )}
      </div>
    </aside>
  );
}

/**
 * The issue's branch exists already: what is on it, and what to do. Deleting
 * asks once more, naming what goes with it.
 */
function ExistingBranch(
  { plan, issue, existing, issueActions }:
  { plan: Plan; issue: PlanIssue; existing: ExistingIssueBranch; issueActions: IssueActions },
): JSX.Element {
  const [deleting, setDeleting] = useState(false);
  const { branch, worktreePath, sessionId } = existing;

  if (deleting) {
    return (
      <div className="pv-confirm is-error" role="alertdialog" aria-label="Delete worktree and branch">
        <span>{deleteLine(existing)}</span>
        <div className="pv-confirm-buttons">
          <button type="button" className="sw-btn is-warn" onClick={() => issueActions.startAgain?.(issue, plan, 'replace')}>
            Delete and start again
          </button>
          <button type="button" className="sw-btn" onClick={() => setDeleting(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="pv-confirm" role="alert" aria-label="Branch exists">
      <span>{existingLine(existing)}</span>
      <div className="pv-confirm-buttons">
        <button type="button" className="sw-btn is-primary" onClick={() => issueActions.startAgain?.(issue, plan, 'reuse')}>
          Continue work
        </button>
        {sessionId && issueActions.jumpToSession && (
          <button type="button" className="sw-btn" onClick={() => issueActions.jumpToSession!(sessionId)}>
            Open its session
          </button>
        )}
        {!existing.main && (
          <button type="button" className="sw-btn is-warn" onClick={() => setDeleting(true)}>
            {worktreePath ? 'Delete worktree and branch…' : 'Delete branch…'}
          </button>
        )}
      </div>
      <span className="pv-confirm-note">{'Branch ' + branch}</span>
    </div>
  );
}

/** Where the existing branch is and what is on it. */
export function existingLine({ worktreePath, main, changedFiles, ahead }: ExistingIssueBranch): string {
  if (main) return 'Its branch exists already, checked out in the main checkout.';
  if (!worktreePath) return 'Its branch exists already, without a worktree.';
  const work = [
    changedFiles ? plural(changedFiles, 'uncommitted file') : '',
    ahead ? plural(ahead, 'commit') + ' not on the default branch' : '',
  ].filter(Boolean);
  return 'Its branch exists already, in a worktree with ' + (work.length ? work.join(' and ') : 'no work on it yet') + '.';
}

/** What deleting takes with it, asked before it does. */
export function deleteLine({ worktreePath, changedFiles, ahead }: ExistingIssueBranch): string {
  const lost = [
    changedFiles ? plural(changedFiles, 'uncommitted file') : '',
    ahead ? plural(ahead, 'commit') + ' not on the default branch' : '',
  ].filter(Boolean);
  const what = worktreePath ? 'its worktree and branch' : 'its branch';
  return lost.length
    ? `Delete ${what}, with ${lost.join(' and ')}? Anything not pushed is gone for good.`
    : `Delete ${what}, then start again from scratch? Anything not pushed is gone for good.`;
}

function plural(count: number, noun: string): string {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

/** What starting a Locked issue early stacks on (A3), said before it is confirmed. */
export function stackLine(plan: Plan, issue: IssueKey): string {
  const base = startBase(plan, issue);
  if (base.kind === 'stacked') {
    return `Stacked on ${shortRef(plan, base.blocker)}: branches off PR #${base.pullRequest.number} (${base.pullRequest.headRef}), and its PR targets that branch.`;
  }
  const waiting = base.openBlockers.map(blocker => shortRef(plan, blocker)).join(', ');
  return waiting
    ? `No PR to stack on yet: starts from the default branch, ahead of ${waiting}.`
    : 'Starts from the default branch.';
}
