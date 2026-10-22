/**
 * The project page's Pull requests section (#175), under Plans & issues: each
 * open PR as a two-line row with its state, title, number and head branch,
 * then an "in #n" chip when it closes an issue in a plan (a click expands that
 * plan), its checks and where its review stands. Drafts are dimmed. Show
 * merged adds the merged ones after them. A click, or ↵, opens it on GitHub.
 *
 * Which rows are on screen is `page-rows`, shared with the page's keys. Until
 * the first answer the section shimmers; when GitHub had nothing to say it is
 * left out, and the page says why in its place (`GitHubMessage`).
 */
import type { JSX, MouseEvent } from 'react';
import { useStore } from '../use-store';
import { dispatch } from '../../state/app-store';
import type { IssueKey } from '../../../domain/plan/model';
import { checksPill, cursorId, pullRequestsViewOf, reviewText } from './page-rows';
import { openPullRequestOnGitHub, revealPlan } from './actions';
import { SectionSkeleton } from './SectionSkeleton';

export function PullRequestsSection({ projectPath }: { projectPath: string }): JSX.Element | null {
  const page = useStore(state => state.projectPage);
  const answered = page.overview?.projectPath === projectPath ? page.overview : null;
  const rows = pullRequestsViewOf(page, projectPath);
  if (answered && !rows) return null;

  const github = answered?.github?.ok ? answered.github : null;
  const open = github ? github.pullRequests.filter(row => row.pullRequest.state === 'open').length : 0;
  const merged = github && page.showMerged ? github.pullRequests.length - open : 0;

  return (
    <section className="pp-section pp-prs" aria-labelledby="pp-prs-heading">
      <div className="pp-section-head">
        <h2 id="pp-prs-heading">Pull requests</h2>
        {github && <span className="pp-count">{open} open{merged ? ' · ' + merged + ' merged' : ''}</span>}
        <button type="button" className="pp-link" onClick={() => dispatch({ type: 'projectShowMergedToggled' })}>
          {page.showMerged ? 'Hide merged' : 'Show merged'}
        </button>
      </div>
      <div className="pp-card" aria-busy={!rows}>
        {!rows && <SectionSkeleton label="Loading pull requests" />}
        {rows && rows.length === 0 && (
          <div className="pp-quiet">{page.filter ? 'No pull request here matches.' : 'No open pull requests.'}</div>
        )}
        {rows?.map(({ pullRequest: pr, plan }) => {
          const key: IssueKey = { repository: pr.repository, number: pr.number };
          const id = cursorId.pullRequest(key);
          const state = pr.state === 'merged' ? 'merged' : pr.draft ? 'draft' : 'open';
          const checks = pr.state === 'merged' ? null : checksPill(pr.checks);
          const reveal = (e: MouseEvent): void => {
            e.stopPropagation();
            if (plan) revealPlan(plan);
          };
          return (
            <div
              key={id}
              className={'pp-pr is-' + state + (page.cursor === id ? ' is-cursor' : '')}
              data-cursor-id={id}
              onClick={() => openPullRequestOnGitHub(key)}
            >
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
                  <button type="button" className="pp-pill pp-chip" title={'Show plan #' + plan.number} onClick={reveal}>
                    in #{plan.number}
                  </button>
                )}
                {checks && <span className={'pp-pill is-checks-' + checks.tone}>{checks.text}</span>}
                <span className="pp-review">{reviewText(pr)}</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PullRequestIcon({ state }: { state: 'open' | 'draft' | 'merged' }): JSX.Element {
  const label = state === 'open' ? 'Open' : state === 'draft' ? 'Draft' : 'Merged';
  return (
    <svg className={'pp-state is-pr-' + state} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" role="img" aria-label={label}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      {state === 'merged'
        ? <path d="M6 8.5v7M8.5 6H12a6 6 0 0 1 6 6v3.5" />
        : <path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4" />}
    </svg>
  );
}
