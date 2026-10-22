/**
 * The project page's overview (#173): the header, and the body's two columns,
 * the sections on the left and a 340 px column on the right.
 *
 * The page's keys (#174), while it has the focus and never in an input: ↑/↓
 * move the cursor through every row across sections, → and ← expand and
 * collapse a plan (← on an issue goes up to its plan), ↵ opens what is under
 * the cursor, S starts a session on it, / filters the rows, and Esc closes
 * the page, back to the session it covered, focused. What each key does is
 * `page-keys`; the rows it walks are `page-rows`.
 *
 * The body follows the GitHub part's state (#175, `page-state`): a project
 * with no GitHub remote, or a remote one, has a single column of what is
 * local; when GitHub could not be asked, one message takes the place of Plans
 * and Pull requests; stale data is dimmed under a line saying how old it is.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { dispatch, getState } from '../../state/app-store';
import { useStore } from '../use-store';
import { projectLabel } from '../../features/sessions/project-label';
import { ProjectHeader } from './ProjectHeader';
import { PlansSection } from './PlansSection';
import { SessionsSection, sessionsShown } from './SessionsSection';
import { PullRequestsSection } from './PullRequestsSection';
import { WorktreesSection } from './WorktreesSection';
import { GitHubMessage, RemoteNote, StaleLine } from './EdgeStates';
import {
  closeProject, openIssueOnGitHub, openProjectSettings, openProjectPlan, openProjectSession, openPullRequestOnGitHub,
  startPageIssueSession, startWorktreeSession,
} from './actions';
import {
  pageRows, planRows, plansViewOf, pullRequestRows, pullRequestsViewOf, sessionRows, worktreeRows, worktreesView,
  type PageRow,
} from './page-rows';
import { githubPart, showsWorktrees } from './page-state';
import { pageKeyAction } from './page-keys';
import { isProjectSettingsKey } from '../../lib/shortcut-keys';

/** Every row on the page now, in the order the cursor walks them. */
function currentRows(projectPath: string): PageRow[] {
  const state = getState();
  const page = state.projectPage;
  const plans = plansViewOf(page, projectPath);
  const pullRequests = pullRequestsViewOf(page, projectPath);
  const sessions = sessionsShown(projectPath, state.view.activePtyIds, page.filter);
  const answered = page.overview?.projectPath === projectPath ? page.overview : null;
  const worktrees = answered && showsWorktrees(answered, projectPath) ? worktreesView(answered, page.filter) : [];
  return pageRows({
    plans: plans ? planRows(plans) : [],
    pullRequests: pullRequests ? pullRequestRows(pullRequests) : [],
    sessions: sessionRows(sessions.lines.map(line => line.session.sessionId)),
    worktrees: worktreeRows(worktrees),
  });
}

export function ProjectOverview({ projectPath }: { projectPath: string }): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const cursor = useStore(state => state.projectPage.cursor);
  const filter = useStore(state => state.projectPage.filter);
  const overview = useStore(state => state.projectPage.overview);
  const github = githubPart(overview, projectPath);
  const [filtering, setFiltering] = useState(false);

  // Into the page as it opens, so its keys reach it without a click.
  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [projectPath]);

  // The row under the cursor stays in view.
  useEffect(() => {
    if (!cursor) return;
    root.current?.querySelector(`[data-cursor-id="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useLayoutEffect(() => {
    if (filtering) filterInput.current?.focus();
  }, [filtering]);

  const closeFilter = (clear: boolean): void => {
    if (clear) dispatch({ type: 'projectFilterChanged', filter: '' });
    setFiltering(false);
    root.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (isProjectSettingsKey(e.nativeEvent)) {
      e.preventDefault();
      openProjectSettings(projectPath);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Escape' && !e.shiftKey) {
      e.preventDefault();
      if (filter) dispatch({ type: 'projectFilterChanged', filter: '' });
      else closeProject();
      return;
    }
    // S is the only key that comes shifted as well; the rest are bare.
    if (e.shiftKey && e.key !== 'S') return;
    const action = pageKeyAction(e.key, currentRows(projectPath), getState().projectPage.cursor);
    if (!action) return;
    e.preventDefault();
    switch (action.kind) {
      case 'cursor': dispatch({ type: 'projectCursorMoved', target: action.target }); break;
      case 'expand': dispatch({ type: 'projectPlanExpanded', plan: action.plan }); break;
      case 'collapse': dispatch({ type: 'projectPlanCollapsed', plan: action.plan }); break;
      case 'open-plan': openProjectPlan(projectPath, action.plan); break;
      case 'open-issue': openIssueOnGitHub(action.issue); break;
      case 'open-session': openProjectSession(action.sessionId); break;
      case 'show-more-loose': dispatch({ type: 'projectLooseExpanded' }); break;
      case 'start': void startPageIssueSession(projectPath, action.issue, action.plan); break;
      case 'open-pull-request': openPullRequestOnGitHub(action.pullRequest); break;
      case 'start-worktree': void startWorktreeSession(projectPath, action.path); break;
      case 'filter': setFiltering(true); break;
    }
  };

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFilter(true);
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      // Back to the rows, the cursor on the first that is left.
      e.preventDefault();
      e.stopPropagation();
      const first = currentRows(projectPath)[0];
      dispatch({ type: 'projectCursorMoved', target: first?.id ?? null });
      closeFilter(false);
    }
  };

  return (
    <div
      ref={root}
      className="sw-page project-page"
      tabIndex={-1}
      role="region"
      aria-label={'Project ' + projectLabel(projectPath)}
      onKeyDown={onKeyDown}
    >
      <ProjectHeader projectPath={projectPath} />
      {(filtering || filter) && (
        <div className="pp-filter">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
          </svg>
          <input
            ref={filterInput}
            type="text"
            className="pp-filter-input"
            aria-label="Filter rows"
            placeholder="Filter rows"
            value={filter}
            spellCheck={false}
            onChange={e => dispatch({ type: 'projectFilterChanged', filter: e.target.value })}
            onKeyDown={onFilterKeyDown}
            onBlur={() => { if (!getState().projectPage.filter) setFiltering(false); }}
          />
          <kbd className="sw-kbd">esc</kbd>
        </div>
      )}
      {github.kind === 'remote' || github.kind === 'none' ? (
        <div className="pp-body is-local">
          <div className="pp-column">
            <SessionsSection projectPath={projectPath} />
            {github.kind === 'remote' ? <RemoteNote /> : <WorktreesSection projectPath={projectPath} />}
          </div>
        </div>
      ) : (
        <div className="pp-body">
          <div className={'pp-column' + (github.kind === 'ok' && github.stale ? ' is-stale' : '')}>
            {github.kind === 'ok' && github.stale && <StaleLine fetchedAt={github.fetchedAt} />}
            {github.kind === 'unavailable' ? <GitHubMessage reason={github.reason} /> : (
              <>
                <PlansSection projectPath={projectPath} />
                <PullRequestsSection projectPath={projectPath} />
              </>
            )}
          </div>
          <div className="pp-column pp-side">
            <SessionsSection projectPath={projectPath} />
            <WorktreesSection projectPath={projectPath} />
          </div>
        </div>
      )}
    </div>
  );
}
