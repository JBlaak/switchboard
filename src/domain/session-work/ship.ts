/**
 * The progress of a **Ship it**, as four steps.
 *
 * Ship it is one prompt (A4), and Claude does not report back in a form the
 * page could parse, so the steps are worked out from what the page polls
 * itself: how far behind the PR is, its checks, and whether it merged. That
 * keeps the card honest — it shows what GitHub says, not what Claude claims.
 */
import type { Activity, PullRequestStatus } from './model';

export type ShipStepId = 'rebase' | 'ci' | 'merge' | 'cleanup';

export type ShipStepState = 'done' | 'running' | 'todo' | 'failed';

export interface ShipStep {
  id: ShipStepId;
  label: string;
  state: ShipStepState;
}

const LABELS: Record<ShipStepId, string> = {
  rebase: 'Rebased',
  ci: 'Waiting for CI',
  merge: 'Merge',
  cleanup: 'Clean up',
};

/**
 * Rebased · waiting for CI · merge · clean up, each done, running, to do or failed.
 *
 * Steps run in order, so a step is only ever running once the one before it is
 * done, and — CI aside, which runs whether anyone waits on it or not — only
 * while a Ship it is with Claude; without one the card still shows what is
 * already true, and a failing check nobody is fixing shows as failed. When
 * Claude gives up, the step it was on is the
 * one that failed. Clean up (removing the worktree, pulling main) leaves no
 * trace on the PR, so it counts as done when the Ship it does.
 */
export function shipSteps(pr: PullRequestStatus, activity: Activity | null | undefined): ShipStep[] {
  const shipping = activity?.action === 'ship' ? activity : null;
  // A queued Ship it has not started: nothing is running until it is typed in.
  const active = shipping?.phase === 'sent';
  const gaveUp = shipping?.phase === 'gave-up';
  const merged = pr.state === 'merged';

  // Where the PR is stuck when it is not done: running while Claude works on
  // it, failed once Claude has given up, to do otherwise.
  const pending = (stuck: boolean): ShipStepState => {
    if (gaveUp) return 'failed';
    if (active) return 'running';
    return stuck ? 'failed' : 'todo';
  };

  const rebaseDone = merged || (pr.behindBy === 0 && pr.mergeable !== 'conflicting');
  const rebase: ShipStepState = rebaseDone ? 'done' : pending(false);

  const checks = (pr.checks ?? []).filter((check) => check.state !== 'skipped');
  const failing = checks.some((check) => check.state === 'failing');
  const ciPending = pr.checks === undefined || checks.some((check) => check.state === 'pending');
  let ci: ShipStepState;
  if (merged) ci = 'done';
  else if (!rebaseDone) ci = 'todo';
  else if (failing) ci = pending(!active);
  else if (ciPending) ci = gaveUp ? 'failed' : 'running';
  else ci = 'done';

  let merge: ShipStepState;
  if (merged) merge = 'done';
  else if (pr.state === 'closed') merge = 'failed';
  else if (ci !== 'done') merge = 'todo';
  else merge = pending(false);

  let cleanup: ShipStepState;
  if (!merged) cleanup = 'todo';
  else if (shipping?.phase === 'done' || !shipping) cleanup = 'done';
  else cleanup = gaveUp ? 'failed' : 'running';

  return [
    { id: 'rebase', label: LABELS.rebase, state: rebase },
    { id: 'ci', label: LABELS.ci, state: ci },
    { id: 'merge', label: LABELS.merge, state: merge },
    { id: 'cleanup', label: LABELS.cleanup, state: cleanup },
  ];
}
