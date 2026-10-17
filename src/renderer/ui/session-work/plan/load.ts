/**
 * What the plan view does: asking main for its plans, and the handlers its
 * components call — hover, select, step, choose, pick another plan, open a
 * GitHub page. Everything dispatches; nothing here needs a session, so #128's
 * Plan view without one uses the same functions.
 *
 * (`plan/actions.ts` is #125's: starting and jumping to issue sessions;
 * `plan/issue-actions.ts` wires those to the view.)
 */
import { dispatch, getState } from '../../../state/app-store';
import { chosenPlan, planSourceKey, steppedIssue } from '../../../state/plan-slice';
import type { PlanSource, PlanViewState, SessionPlansAnswer } from '../../../state/plan-slice';
import { layOutPlan } from '../../../../domain/plan/layout';
import { issueKeyString } from '../../../../domain/plan/model';
import type { IssueKey, PlanSummary } from '../../../../domain/plan/model';
import type { PlanHandlers } from './types';
import { loadIssueSessions } from './actions';

/** Sources being asked right now, so a poll never stacks on a slow answer. */
const asking = new Set<string>();

/** Ask main for the view's plans, and dispatch the answer (null when it failed). */
export async function loadPlanView(view: Pick<PlanViewState, 'owner' | 'source'>): Promise<void> {
  const sourceKey = planSourceKey(view.source);
  const ask = view.owner + '\0' + sourceKey;
  if (asking.has(ask)) return;
  asking.add(ask);
  let answer: SessionPlansAnswer | null = null;
  try {
    answer = await fetchSource(view.source);
  } catch {
    answer = null;
  } finally {
    asking.delete(ask);
  }
  dispatch({ type: 'planLoaded', owner: view.owner, sourceKey, answer });
  if (answer) await loadOwners(view.owner, answer);
}

/** Which sessions own the plans' issues (S1), across every repository the plans are in. */
async function loadOwners(owner: string, answer: SessionPlansAnswer): Promise<void> {
  const repositories = [...new Set(answer.plans.flatMap(plan => [plan.repository, ...plan.issues.map(i => i.repository)]))];
  const found = await Promise.all(repositories.map(repository => loadIssueSessions(repository)));
  dispatch({ type: 'planOwnersLoaded', owner, owners: Object.assign({}, ...found) });
}

async function fetchSource(source: PlanSource): Promise<SessionPlansAnswer | null> {
  if (source.kind === 'session') return await window.api.sessionPlans(source.sessionId);
  const plan = await window.api.plan(source.repository, source.number);
  return plan ? { plans: [plan], others: [] } : null;
}

// ── The handlers ──

function hover(issue: IssueKey | null): void {
  dispatch({ type: 'planIssueHovered', issue });
}

function select(issue: IssueKey | null): void {
  dispatch({ type: 'planIssueSelected', issue });
}

/** ↑/↓: the previous or next issue in level order; nothing at either end. Answers the issue moved to. */
export function stepIssue(direction: 1 | -1): IssueKey | null {
  const view = getState().plan.view;
  const plan = view ? chosenPlan(view) : null;
  if (!view || !plan) return null;
  const next = steppedIssue(layOutPlan(plan).levels.flat(), view.selected, direction);
  if (next) select(next);
  return next;
}

function pickOther(summary: PlanSummary): void {
  const view = getState().plan.view;
  if (!view) return;
  dispatch({
    type: 'planSourcePicked', owner: view.owner,
    source: { kind: 'plan', repository: summary.repository, number: summary.number },
  });
}

function back(): void {
  const view = getState().plan.view;
  if (view?.from) dispatch({ type: 'planSourcePicked', owner: view.owner, source: view.from });
}

export const planHandlers: PlanHandlers = {
  choose: plan => dispatch({ type: 'planChosen', plan }),
  hover,
  select,
  step: (direction) => { stepIssue(direction); },
  open: url => { void window.api.openExternal(url); },
  pickOther,
  back,
};

/**
 * A key on a page showing the plan view: Esc closes the detail, ↑/↓ step
 * through the issues while it is open (D4). Answers whether the key was taken;
 * Esc with no detail open is left to the page (back to the terminal).
 */
export function planKey(key: string): boolean {
  const view = getState().plan.view;
  if (!view?.selected) return false;
  if (key === 'Escape') {
    select(null);
    return true;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const next = stepIssue(key === 'ArrowDown' ? 1 : -1);
    if (next) {
      document.querySelector<HTMLElement>(`[data-plan-issue="${CSS.escape(issueKeyString(next))}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return true;
  }
  return false;
}
