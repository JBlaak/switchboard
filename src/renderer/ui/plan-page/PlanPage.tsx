/**
 * The Plan view without a session (F2, #128): a plan picked in the New
 * Session picker, in the main area, with no session started. A header names
 * the project and closes the view; below it, the same plan view as the
 * Session work page's Plan tab, with its diagram, detail, actions and polling.
 *
 * Rendered into `#plan-page`, which `install-plan-page` shows and hides. Esc
 * closes an open issue detail first, then the view; ↑/↓ step through the
 * issues while the detail is open (D4).
 */
import { useLayoutEffect, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { useStore } from '../use-store';
import { planPageOwner } from '../../state/plan-page-slice';
import { projectLabel } from '../../features/sessions/project-label';
import { PlanView } from '../session-work/plan/PlanView';
import { planKey } from '../session-work/plan/load';
import { useIssueActions } from '../session-work/plan/issue-actions';
import { closePlanPage } from './actions';

export function PlanPage(): JSX.Element | null {
  const page = useStore(state => state.planPage.open);
  const view = useStore(state => state.plan.view);
  const root = useRef<HTMLDivElement>(null);
  const issueActions = useIssueActions(page?.projectPath ?? null);
  const owner = page ? planPageOwner(page) : null;

  // Into the page as it opens, so Esc and ↑/↓ reach it without a click.
  useLayoutEffect(() => {
    if (owner) root.current?.focus({ preventScroll: true });
  }, [owner]);

  if (!page) return null;

  const mine = view && view.owner === owner ? view : null;
  const plan = mine?.answer?.plans[0] ?? null;
  const name = projectLabel(page.projectPath);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if ((e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
    if (planKey(e.key)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePlanPage();
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
      <header className="sw-header">
        <div className="sw-header-row">
          <button type="button" className="sw-btn sw-back" onClick={closePlanPage} aria-label="Close plan (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
            Close <kbd className="sw-kbd">esc</kbd>
          </button>
          <div className="sw-heading">
            <h1 className="sw-title">{'Plan · ' + name}</h1>
            <div className="sw-subline">
              <span>{page.repository + '#' + page.number}</span>
              <span className="sw-updated">No session. Start one from an issue.</span>
            </div>
          </div>
        </div>
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
