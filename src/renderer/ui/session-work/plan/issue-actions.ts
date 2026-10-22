/**
 * The plan view's session actions (A1–A3, S1), wired to #125's `actions.ts`
 * and the plan slice: which session owns an issue and whether it is working,
 * Jump to session, and Start session — straight away on a Ready issue, after
 * a confirmation that says what it stacks on for a Locked one — and Start
 * level, one session with an agent on every Ready issue of the current level,
 * after one confirmation (A1).
 *
 * Starting needs a project to make the worktree in; without one the view
 * offers no Start session.
 */
import { useMemo } from 'react';
import { dispatch, getState } from '../../../state/app-store';
import { sessionMap } from '../../../state/session-store';
import { useStore } from '../../use-store';
import { headerNameFor } from '../../../features/sessions/terminal-header';
import { layOutPlan } from '../../../../domain/plan/layout';
import { issueKeyString, sameIssue } from '../../../../domain/plan/model';
import type { IssueKey, Plan } from '../../../../domain/plan/model';
import type { IdRecord } from '../../../state/records';
import { issueSessionSteps, jumpToSession, startIssueSession } from './actions';
import type { IssueActions, IssueSession } from './types';
import { startLevelWith } from './start-level';
import { reloadOwners } from './load';
import { pulseSessionRow } from '../../session-list/pulse';

const NO_OWNERS: IdRecord<string> = {};
const NO_BUSY: IdRecord<boolean> = {};

/** The owner of an issue, named the way the terminal header names it. */
export function issueSession(
  owners: IdRecord<string>, busy: IdRecord<boolean>, issue: IssueKey,
  nameOf: (sessionId: string) => string | null,
): IssueSession | null {
  const id = owners[issueKeyString(issue)];
  if (!id) return null;
  return { id, name: nameOf(id) || 'Untitled session', working: busy[id] === true };
}

function nameOf(sessionId: string): string | null {
  const session = sessionMap.get(sessionId);
  return session ? headerNameFor(session) : null;
}

async function start(projectPath: string, issue: IssueKey, plan: Plan, show: boolean): Promise<void> {
  dispatch({ type: 'planStartAsked', issue, confirm: false });
  const result = await startIssueSession({ projectPath, issue, plan, show }).catch((err: Error) => ({
    ok: false as const, reason: err.message || 'Could not start the session',
  }));
  // Started without taking the screen: its new row says so instead.
  if (result.ok && !show) pulseSessionRow(result.sessionId);
  dispatch({ type: 'planStartAnswered', issue, result });
}

/**
 * Start level (A1): one session in the background, with an agent on every
 * asked issue, so the plan view stays on screen; then the report, and the
 * owners asked again.
 */
async function startLevel(projectPath: string, plan: Plan, pulse: boolean): Promise<void> {
  const asking = getState().plan.levelStart;
  if (asking?.phase !== 'confirm' || !sameIssue(asking.plan, plan)) return;
  dispatch({ type: 'planLevelStartConfirmed' });
  const { sessionId, ...report } = await startLevelWith(issueSessionSteps, { projectPath, plan, level: asking.level, issues: asking.issues });
  if (sessionId && pulse) pulseSessionRow(sessionId);
  dispatch({ type: 'planLevelStartAnswered', ...report });
  await reloadOwners();
}

/**
 * The actions for a plan view whose sessions start in `projectPath`; null
 * starts none. A session started on one issue is put on screen, unless `show`
 * is false: the project page keeps the main area (#173), and every row it
 * starts, one issue's or a level's, pulses once in the sidebar instead.
 */
export function useIssueActions(projectPath: string | null, { show = true }: { show?: boolean } = {}): IssueActions {
  const owners = useStore(state => state.plan.view?.owners ?? NO_OWNERS);
  const busy = useStore(state => state.activity.busy ?? NO_BUSY);
  const pending = useStore(state => state.plan.view?.start ?? null);
  const levelStart = useStore(state => state.plan.levelStart);

  return useMemo<IssueActions>(() => {
    const actions: IssueActions = {
      sessionFor: issue => issueSession(owners, busy, issue, nameOf),
      jumpToSession: (sessionId) => { void jumpToSession(sessionId); },
      start: pending,
      levelStart,
    };
    if (!projectPath) return actions;
    return {
      ...actions,
      startSession: (issue, plan) => {
        if (layOutPlan(plan).stateOf(issue) === 'locked') dispatch({ type: 'planStartAsked', issue, confirm: true });
        else void start(projectPath, issue, plan, show);
      },
      confirmStart: (plan) => {
        const asking = getState().plan.view?.start;
        if (asking?.phase === 'confirm') void start(projectPath, asking.issue, plan, show);
      },
      cancelStart: () => dispatch({ type: 'planStartCancelled' }),
      startLevel: (plan, level, issues) => dispatch({ type: 'planLevelStartAsked', plan, level, issues }),
      confirmLevelStart: (plan) => { void startLevel(projectPath, plan, !show); },
      cancelLevelStart: () => dispatch({ type: 'planLevelStartCancelled' }),
    };
  }, [owners, busy, pending, levelStart, projectPath, show]);
}
