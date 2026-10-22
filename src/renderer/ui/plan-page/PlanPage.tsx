/**
 * A plan inside the project page (F2, #128, #173): the route `project → plan`,
 * with no session started. A breadcrumb leads back to the project's overview
 * (‹ project / Plans, ⌘[); below it, the same plan view as the Session work
 * page's Plan tab, with its diagram, detail, actions and polling.
 *
 * Starting a session here keeps the page where it is: the new row appears in
 * the sidebar and pulses once instead of taking the main area.
 *
 * Rendered by `ui/project-page/ProjectPage`. Esc closes an open issue detail
 * first, then the page, which goes back to the session it covered; ↑/↓ step
 * through the issues while the detail is open (D4).
 */
import { useLayoutEffect, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { useStore } from '../use-store';
import { projectPlan, projectPlanOwner } from '../../state/main-area-slice';
import { projectLabel } from '../../features/sessions/project-label';
import { PlanView } from '../session-work/plan/PlanView';
import { planKey } from '../session-work/plan/load';
import { useIssueActions } from '../session-work/plan/issue-actions';
import { backToProject, closeProject } from '../project-page/actions';
import type { PlanPage as Plan } from './actions';

export function PlanPage(): JSX.Element | null {
  const page = useStore(state => projectPlan(state.mainArea), samePlan);
  const view = useStore(state => state.plan.view);
  const root = useRef<HTMLDivElement>(null);
  const issueActions = useIssueActions(page?.projectPath ?? null, { show: false });
  const owner = page ? projectPlanOwner(page) : null;

  // Into the page as it opens, so Esc and ↑/↓ reach it without a click.
  useLayoutEffect(() => {
    if (owner) root.current?.focus({ preventScroll: true });
  }, [owner]);

  if (!page) return null;

  const mine = view && view.owner === owner ? view : null;
  const plan = mine?.answer?.plans[0] ?? null;
  const name = projectLabel(page.projectPath);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (isBackKey(e)) {
      e.preventDefault();
      backToProject();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if ((e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
    if (planKey(e.key)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeProject();
    }
  };

  return (
    <div
      ref={root}
      className="sw-page plan-page"
      tabIndex={-1}
      role="region"
      aria-label={'Plan in ' + name}
      onKeyDown={onKeyDown}
    >
      <header className="sw-header pp-crumbs-header">
        <nav className="pp-crumbs" aria-label="Breadcrumb">
          <button type="button" className="pp-crumb" onClick={backToProject} aria-label={'Back to ' + name + ' (⌘[)'}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 6-6 6 6 6" />
            </svg>
            {name}
          </button>
          <span className="pp-crumb-sep" aria-hidden="true">/</span>
          <span className="pp-crumb-here" aria-current="page">Plans</span>
          <kbd className="sw-kbd">⌘[</kbd>
        </nav>
      </header>
      {plan
        ? <PlanView plan={plan} issueActions={issueActions} />
        : (
          <div className="pv pv-status" role="status">
            {mine?.phase === 'failed'
              ? 'Couldn’t ask GitHub for this plan. Trying again in a minute.'
              : 'Loading the plan…'}
          </div>
        )}
    </div>
  );
}

/** ⌘[ : back from the plan to the project's overview. */
function isBackKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'BracketLeft';
}

/** A fresh object per read, so equal when it names the same plan. */
function samePlan(a: Plan | null, b: Plan | null): boolean {
  return a === b || (!!a && !!b && a.projectPath === b.projectPath && a.repository === b.repository && a.number === b.number);
}
