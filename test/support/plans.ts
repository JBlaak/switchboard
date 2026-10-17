/** Small plans for the plan view's tests, built in code. */
import type { IssueKey, Plan, PlanIssue, PlanPullRequest } from '../../src/domain/plan/model';

export const REPO = 'acme/app';

export function key(number: number, repository = REPO): IssueKey {
  return { repository, number };
}

export function pr(number: number, state: PlanPullRequest['state'], draft = false): PlanPullRequest {
  return { number, state, draft, additions: 10, deletions: 2, headRef: 'branch-' + number, baseRef: 'main' };
}

export function issue(number: number, fields: Partial<PlanIssue> = {}): PlanIssue {
  return {
    repository: REPO, number, title: 'Issue ' + number, state: 'open', closedAs: null,
    updatedAt: '2026-10-17T00:00:00Z', blockedBy: [], pullRequests: [], summary: '', acceptance: [],
    ...fields,
  };
}

export function needs(number: number, blockers: number[], fields: Partial<PlanIssue> = {}): PlanIssue {
  return issue(number, { blockedBy: blockers.map(n => key(n)), ...fields });
}

export function merged(number: number, blockers: number[] = []): PlanIssue {
  return needs(number, blockers, { state: 'closed', closedAs: 'completed', pullRequests: [pr(number + 100, 'merged')] });
}

export function plan(issues: PlanIssue[], fields: Partial<Plan> = {}): Plan {
  return { repository: REPO, number: 1, title: 'Epic', parent: null, issues, outside: [], ...fields };
}

/**
 * A diamond with a tail, and an unrelated issue:
 *
 *   L1:  10 (merged)        14 (open)
 *   L2:  11 (open, PR)  12 (ready)
 *   L3:  13 (locked)
 */
export function diamond(): Plan {
  return plan([
    merged(10),
    needs(11, [10], { pullRequests: [pr(111, 'open')] }),
    needs(12, [10]),
    needs(13, [11, 12]),
    issue(14),
  ]);
}
