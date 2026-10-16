/**
 * How a PR is doing, in the one colour a sidebar chip has room for (W4).
 *
 * The chip is glanced at, not read, so it only says which way to look: green
 * is fine, amber is something in motion (CI running, Claude working), red is
 * stuck (a check failing that nobody is fixing, or Claude giving up and handing
 * it back to you).
 */
import type { Activity, PullRequestStatus } from './model';

export type StatusDot = 'green' | 'amber' | 'red';

const SEVERITY: Record<StatusDot, number> = { green: 0, amber: 1, red: 2 };

/** Is an action on its way to Claude or with it right now? */
export function isWorking(activity: Activity | null | undefined): boolean {
  return activity?.phase === 'queued' || activity?.phase === 'sent';
}

/**
 * Does this PR wait on you rather than on CI or Claude?
 *
 * Either auto-fix spent its attempts (W3), or Claude answered a review thread
 * and left it open because it wants your call (C5).
 */
export function needsYou(pr: PullRequestStatus, activity: Activity | null | undefined): boolean {
  if (activity?.phase === 'gave-up') return true;
  return (pr.threads ?? []).some((thread) => !thread.resolved && thread.needsYou === true);
}

/**
 * The colour of a PR's chip.
 *
 * A failing check that Claude is already working on is amber, not red: with
 * auto-fix on, every failure is handed over within a poll, and a dot that
 * flashed red each time would cry wolf. It turns red when Claude gives up. A
 * merged or closed PR has nothing left to do, and nothing known about checks
 * (no `gh`) is not a reason to alarm anyone, so both are green.
 */
export function statusDot(pr: PullRequestStatus, activity: Activity | null | undefined): StatusDot {
  if (pr.state === 'merged' || pr.state === 'closed') return 'green';
  if (needsYou(pr, activity)) return 'red';
  if (isWorking(activity)) return 'amber';
  const checks = pr.checks ?? [];
  if (checks.some((check) => check.state === 'failing')) return 'red';
  if (checks.some((check) => check.state === 'pending')) return 'amber';
  return 'green';
}

/**
 * The worst of several dots, or null for none — the `+N` chip's colour.
 *
 * The chip hides PRs, and hiding a red one behind a green chip would hide the
 * one thing the dot is for.
 */
export function worstStatusDot(dots: Iterable<StatusDot>): StatusDot | null {
  let worst: StatusDot | null = null;
  for (const dot of dots) {
    if (worst === null || SEVERITY[dot] > SEVERITY[worst]) worst = dot;
  }
  return worst;
}
