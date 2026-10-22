/**
 * The project page's Plans & issues section (#174): each plan one 48 px row
 * with its progress, expanding in place to its issues in level order; then
 * the open issues that are in no plan, eight of them until Show N more.
 * Show closed adds the closed plans, dimmed and last.
 *
 * A plan row's click opens the plan inside the page, its chevron expands it.
 * An issue's click opens it on GitHub; Start session, on hover or under the
 * cursor, starts a session on a startable issue without leaving the page.
 *
 * Reads the overview `install-project-page` keeps asking for; which rows are
 * on screen is `page-rows`, shared with the page's keys. Until the first
 * answer the section shimmers. When GitHub had nothing to say the section is
 * left out; #175 says why in its place.
 */
import type { JSX, MouseEvent, ReactNode } from 'react';
import { useStore } from '../use-store';
import { sessionMap } from '../../state/session-store';
import { sessionDisplayName } from '../../state/session-list-layout';
import { issueKeyString } from '../../../domain/plan/model';
import type { IssueKey } from '../../../domain/plan/model';
import type { IssueLabel, ProjectPullRequest } from '../../../domain/project/overview';
import type { IssueRowStatus, PlanIssueRow } from '../../../domain/plan/project-overview';
import type { ProjectIssueStart } from '../../state/project-page-slice';
import { cursorId, plansViewOf, progressSegments, runningCount, type PlanOnScreen } from './page-rows';
import { openIssueOnGitHub, openProjectPlan, startPageIssueSession } from './actions';
import { dispatch } from '../../state/app-store';
import type { SectionProps } from './slots';

export function PlansSection({ projectPath }: SectionProps): JSX.Element | null {
  const page = useStore(state => state.projectPage);
  const answered = page.overview?.projectPath === projectPath ? page.overview : null;
  const view = plansViewOf(page, projectPath);
  if (answered && !view) return null;

  const github = answered?.github?.ok ? answered.github : null;
  const planCount = github ? github.plans.filter(plan => page.showClosed || plan.state === 'open').length : 0;
  const looseCount = github ? github.loose.length : 0;

  return (
    <section className="pp-section pp-plans" aria-labelledby="pp-plans-heading">
      <div className="pp-section-head">
        <h2 id="pp-plans-heading">Plans &amp; issues</h2>
        {github && (
          <span className="pp-count">
            {plural(planCount, 'plan')} · {plural(looseCount, 'other issue')}
          </span>
        )}
        <button type="button" className="pp-link" onClick={() => dispatch({ type: 'projectShowClosedToggled' })}>
          {page.showClosed ? 'Hide closed' : 'Show closed'}
        </button>
      </div>
      <div className="pp-card" aria-busy={!view}>
        {!view && <SectionSkeleton />}
        {view && view.plans.length === 0 && view.loose.length === 0 && (
          <div className="pp-quiet">{page.filter ? 'Nothing here matches “' + page.filter + '”.' : 'No open plans or issues.'}</div>
        )}
        {view?.plans.map(onScreen => (
          <PlanRows
            key={issueKeyString(onScreen.plan.plan)}
            projectPath={projectPath}
            onScreen={onScreen}
            cursor={page.cursor}
            start={page.start}
          />
        ))}
        {view && view.loose.length > 0 && <div className="pp-subhead">Not in a plan</div>}
        {view?.loose.map(({ issue }) => {
          const key: IssueKey = { repository: issue.repository, number: issue.number };
          const id = cursorId.issue(key);
          return (
            <div
              key={id}
              className={'pp-issue is-loose' + (page.cursor === id ? ' is-cursor' : '')}
              data-cursor-id={id}
              onClick={() => openIssueOnGitHub(key)}
            >
              <OpenIcon />
              <span className="pp-issue-title">{issue.title}</span>
              <span className="pp-num">#{issue.number}</span>
              <span className="pp-right">
                {issue.labels.slice(0, 2).map(label => <LabelPill key={label.name} label={label} />)}
              </span>
            </div>
          );
        })}
        {view && view.hiddenLoose > 0 && (
          <button
            type="button"
            className={'pp-more' + (page.cursor === cursorId.moreLoose ? ' is-cursor' : '')}
            data-cursor-id={cursorId.moreLoose}
            onClick={() => dispatch({ type: 'projectLooseExpanded' })}
          >
            Show {view.hiddenLoose} more
          </button>
        )}
      </div>
    </section>
  );
}

interface PlanRowsProps {
  projectPath: string;
  onScreen: PlanOnScreen;
  cursor: string | null;
  start: ProjectIssueStart | null;
}

/** A plan's row and, expanded, its issues' rows. */
function PlanRows({ projectPath, onScreen, cursor, start }: PlanRowsProps): JSX.Element {
  const { plan, expanded, issues } = onScreen;
  const key: IssueKey = { repository: plan.plan.repository, number: plan.plan.number };
  const id = cursorId.plan(key);
  const running = runningCount(plan);
  const closed = plan.state === 'closed';
  const toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    dispatch({ type: 'projectPlanToggled', plan: issueKeyString(key) });
  };

  return (
    <div className={'pp-plan-group' + (closed ? ' is-closed' : '')} data-plan={issueKeyString(key)}>
      <div
        className={'pp-plan' + (cursor === id ? ' is-cursor' : '')}
        data-cursor-id={id}
        onClick={() => openProjectPlan(projectPath, key)}
      >
        <button
          type="button"
          className={'pp-chevron' + (expanded ? ' is-open' : '')}
          aria-label={(expanded ? 'Collapse plan ' : 'Expand plan ') + plan.plan.title}
          aria-expanded={expanded}
          onClick={toggle}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        <span className="pp-plan-title">{plan.plan.title}</span>
        <span className="pp-num">#{plan.plan.number}</span>
        {running > 0 && (
          <span className="pp-pill is-running"><span className="pp-pill-dot" />{running} running</span>
        )}
        <span className="pp-segments" aria-hidden="true">
          {progressSegments(plan).map((segment, i) => <span key={i} className={'is-' + segment} />)}
        </span>
        <span className="pp-fraction" title={`${plan.progress.closed} of ${plan.progress.total} closed`}>
          {plan.progress.closed}/{plan.progress.total}
        </span>
        <LevelPill plan={plan} />
      </div>
      {expanded && issues.length > 0 && (
        <div className="pp-plan-issues">
          {issues.map(row => (
            <IssueRow key={issueKeyString(row.issue)} projectPath={projectPath} plan={key} row={row} cursor={cursor} start={start} />
          ))}
        </div>
      )}
    </div>
  );
}

function LevelPill({ plan }: { plan: PlanOnScreen['plan'] }): JSX.Element | null {
  if (plan.state === 'closed' || (plan.levelled && plan.progress.current === null)) {
    return <span className="pp-level is-done">Done</span>;
  }
  if (!plan.levelled || plan.progress.current === null) return null;
  return <span className="pp-level">Level {plan.progress.current}</span>;
}

interface IssueRowProps {
  projectPath: string;
  plan: IssueKey;
  row: PlanIssueRow<ProjectPullRequest>;
  cursor: string | null;
  start: ProjectIssueStart | null;
}

/** An issue under its plan: state, title, number, and one status on the right. */
function IssueRow({ projectPath, plan, row, cursor, start }: IssueRowProps): JSX.Element {
  const key: IssueKey = { repository: row.issue.repository, number: row.issue.number };
  const id = cursorId.issue(key);
  const closed = row.issue.state === 'closed';
  const waiting = row.status?.kind === 'waiting';
  const mine = start?.issue === issueKeyString(key) ? start : null;

  return (
    <div
      className={'pp-issue' + (cursor === id ? ' is-cursor' : '') + (closed ? ' is-closed' : '')}
      data-cursor-id={id}
      onClick={() => openIssueOnGitHub(key)}
    >
      {closed ? <ClosedIcon /> : waiting ? <BlockedIcon /> : <OpenIcon />}
      <span className="pp-issue-title">{row.issue.title}</span>
      <span className="pp-num">#{row.issue.number}</span>
      <span className="pp-right">
        <IssueStatus status={row.status} repository={key.repository} />
        {mine?.phase === 'failed' && <span className="pp-start-failed" title={mine.reason}>Could not start</span>}
        {row.startable && (
          <button
            type="button"
            className={'pp-start' + (mine?.phase === 'starting' ? ' is-starting' : '')}
            disabled={mine?.phase === 'starting'}
            onClick={(e) => {
              e.stopPropagation();
              void startPageIssueSession(projectPath, key, plan);
            }}
          >
            {mine?.phase === 'starting' ? 'Starting…' : 'Start session'}
          </button>
        )}
      </span>
    </div>
  );
}

/** The one status an issue row shows: its running session, what it waits on, or its PR. */
function IssueStatus({ status, repository }: { status: IssueRowStatus<ProjectPullRequest>; repository: string }): ReactNode {
  if (!status) return null;
  switch (status.kind) {
    case 'running': {
      const session = sessionMap.get(status.sessionId);
      return (
        <span className="pp-pill is-running">
          <span className="pp-pill-dot" />
          {(session && sessionDisplayName(session)) || 'Running'}
        </span>
      );
    }
    case 'waiting':
      return (
        <span className="pp-waits">
          waits on {status.on.map(on => (on.repository === repository ? '#' + on.number : issueKeyString(on))).join(', ')}
        </span>
      );
    case 'pull-request': {
      const pr = status.pullRequest;
      const state = pr.state === 'merged' ? 'merged' : pr.draft ? 'draft' : 'open';
      return <span className={'pp-pill is-pr-' + state}>#{pr.number} {state}</span>;
    }
  }
}

/** A label, in the colour role its name suggests: bugs red, agent-ready blue, the rest grey. */
function LabelPill({ label }: { label: IssueLabel }): JSX.Element {
  const name = label.name.toLowerCase();
  const role = name.includes('bug') ? ' is-bug' : name.includes('agent') ? ' is-agent' : '';
  return <span className={'pp-pill pp-label' + role}>{label.name}</span>;
}

function SectionSkeleton(): JSX.Element {
  return (
    <div className="pp-skeletons" aria-label="Loading plans and issues">
      <div className="pp-skeleton" />
      <div className="pp-skeleton" />
      <div className="pp-skeleton" />
    </div>
  );
}

function plural(count: number, noun: string): string {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

function OpenIcon(): JSX.Element {
  return (
    <svg className="pp-state is-open" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" role="img" aria-label="Open">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
    </svg>
  );
}

function ClosedIcon(): JSX.Element {
  return (
    <svg className="pp-state is-closed" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Closed">
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}

function BlockedIcon(): JSX.Element {
  return (
    <svg className="pp-state is-blocked" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" role="img" aria-label="Blocked">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
