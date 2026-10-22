/**
 * The New Session picker's plan list (F1, F3): which plans a project shows,
 * in what order, what each row says, and the plans opened recently.
 *
 * Pure, so the rules run under the node test runner without a DOM; the
 * recent list is the project page's (`ui/project-page/recent-plans`, #174).
 */
import { issueKeyString } from '../../../domain/plan/model';
import type { PlanSummary } from '../../../domain/plan/model';

/** The plans opened recently first, latest first; then the rest by their latest activity (F1). */
export function orderPlans(plans: readonly PlanSummary[], recent: readonly string[]): PlanSummary[] {
  const rank = new Map(recent.map((key, i) => [key, i]));
  return [...plans].sort((a, b) => {
    const ra = rank.get(issueKeyString(a));
    const rb = rank.get(issueKeyString(b));
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** The plans the filter keeps: each word of it found in `#number title`, ignoring case. */
export function filterPlans(plans: readonly PlanSummary[], query: string): PlanSummary[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...plans];
  return plans.filter(plan => {
    const text = ('#' + plan.number + ' ' + plan.title).toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** `Level 1 of 3`, `Cleared`, or `No issues` for a plan with none. */
export function planLevelLabel(plan: PlanSummary): string {
  if (plan.levels === 0) return 'No issues';
  return plan.current === null ? 'Cleared' : `Level ${plan.current} of ${plan.levels}`;
}

/** `0 / 5 closed`. */
export function planClosedLabel(plan: PlanSummary): string {
  return `${plan.total - plan.open} / ${plan.total} closed`;
}

/**
 * The row's progress bar, one segment per level: the levels above the current
 * one are cleared, it and the ones below are not yet; a cleared plan is full.
 */
export function planLevelSegments(plan: PlanSummary): ('cleared' | 'current' | 'locked')[] {
  return Array.from({ length: plan.levels }, (_, i) => {
    const level = i + 1;
    if (plan.current === null || level < plan.current) return 'cleared';
    return level === plan.current ? 'current' : 'locked';
  });
}
