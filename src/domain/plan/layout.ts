/**
 * How a plan is drawn: its levels and row order, each issue's state, the
 * current level and the warnings above the diagram.
 *
 * Levels come only from native "Blocked by" links between the plan's own
 * issues (P2): an issue that waits on nothing in the plan is Level 1, any
 * other sits one below the deepest issue it waits on.
 */
import { issueKeyString, type IssueKey, type NodeState, type Plan, type PlanIssue, type PlanLayout, type PlanWarning } from './model';

/** Closed counts as cleared, whether completed or not planned (P6). */
function isClosed(issue: PlanIssue): boolean {
  return issue.state === 'closed';
}

/** P7. An open blocker, in the plan or outside it (P5), locks an open issue without a PR. */
function nodeState(issue: PlanIssue, blockers: PlanIssue[]): NodeState {
  if (issue.state === 'closed') {
    if (issue.closedAs === 'not_planned') return 'not-planned';
    return issue.pullRequests.some((pr) => pr.state === 'merged') ? 'merged' : 'closed';
  }
  const open = issue.pullRequests.filter((pr) => pr.state === 'open');
  if (open.some((pr) => !pr.draft)) return 'review';
  if (open.length > 0) return 'draft';
  return blockers.every(isClosed) ? 'ready' : 'locked';
}

export function layOutPlan(plan: Plan): PlanLayout {
  const inPlan = new Map<string, PlanIssue>();
  for (const issue of plan.issues) inPlan.set(issueKeyString(issue), issue);
  const outside = new Map<string, PlanIssue>();
  for (const issue of plan.outside) {
    const key = issueKeyString(issue);
    if (!inPlan.has(key)) outside.set(key, issue);
  }

  /** The plan issues a plan issue waits on, once each. */
  const planBlockers = new Map<string, PlanIssue[]>();
  /** The outside issues it waits on, once each. */
  const ghostsOf = new Map<string, PlanIssue[]>();
  for (const issue of plan.issues) {
    const key = issueKeyString(issue);
    const inside = new Map<string, PlanIssue>();
    const ghosts = new Map<string, PlanIssue>();
    for (const blocker of issue.blockedBy) {
      const blockerKey = issueKeyString(blocker);
      if (blockerKey === key) continue;
      const found = inPlan.get(blockerKey);
      if (found) inside.set(blockerKey, found);
      else if (outside.has(blockerKey)) ghosts.set(blockerKey, outside.get(blockerKey)!);
    }
    planBlockers.set(key, [...inside.values()]);
    ghostsOf.set(key, [...ghosts.values()]);
  }

  // Levels, depth first. An edge back into an issue still being levelled is a
  // cycle; it is dropped, so a cycle sits where it would without it.
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const levelFor = (key: string): number => {
    const known = level.get(key);
    if (known !== undefined) return known;
    visiting.add(key);
    let deepest = 0;
    for (const blocker of planBlockers.get(key) ?? []) {
      const blockerKey = issueKeyString(blocker);
      if (visiting.has(blockerKey)) continue;
      deepest = Math.max(deepest, levelFor(blockerKey));
    }
    visiting.delete(key);
    level.set(key, deepest + 1);
    return deepest + 1;
  };
  for (const issue of plan.issues) levelFor(issueKeyString(issue));

  // Rows (D1): Level 1 by number, every later row by the average position of
  // its blockers in the rows above, ties by number.
  const byNumber = (a: PlanIssue, b: PlanIssue) =>
    a.number - b.number || a.repository.localeCompare(b.repository);
  const depth = plan.issues.reduce((max, issue) => Math.max(max, level.get(issueKeyString(issue))!), 0);
  const rows: PlanIssue[][] = [];
  const column = new Map<string, number>();
  for (let n = 1; n <= depth; n++) {
    const row = plan.issues.filter((issue) => level.get(issueKeyString(issue)) === n);
    const average = new Map<string, number>();
    for (const issue of row) {
      const above = (planBlockers.get(issueKeyString(issue)) ?? [])
        .map((blocker) => column.get(issueKeyString(blocker)))
        .filter((x): x is number => x !== undefined);
      average.set(issueKeyString(issue), above.length ? above.reduce((a, b) => a + b, 0) / above.length : 0);
    }
    row.sort((a, b) =>
      n === 1 ? byNumber(a, b) : average.get(issueKeyString(a))! - average.get(issueKeyString(b))! || byNumber(a, b));
    row.forEach((issue, x) => column.set(issueKeyString(issue), x));
    rows.push(row);
  }
  const ordered = rows.flat();

  const states = new Map<string, NodeState>();
  for (const issue of plan.issues) {
    const key = issueKeyString(issue);
    states.set(key, nodeState(issue, [...planBlockers.get(key)!, ...ghostsOf.get(key)!]));
  }
  for (const [key, issue] of outside) {
    const blockers = issue.blockedBy
      .map((blocker) => inPlan.get(issueKeyString(blocker)) ?? outside.get(issueKeyString(blocker)))
      .filter((blocker): blocker is PlanIssue => blocker !== undefined && issueKeyString(blocker) !== key);
    states.set(key, nodeState(issue, blockers));
  }

  // P3: the lowest level that still has an open issue.
  const openRow = rows.findIndex((row) => row.some((issue) => !isClosed(issue)));
  const current = openRow === -1 ? null : openRow + 1;

  // D5.
  const warnings: PlanWarning[] = [];
  const linked = plan.issues.some((issue) => planBlockers.get(issueKeyString(issue))!.length > 0);
  if (plan.issues.length >= 2 && !linked) warnings.push({ kind: 'no-links' });
  for (const issue of ordered) {
    if (states.get(issueKeyString(issue)) === 'closed') {
      warnings.push({ kind: 'closed-without-pr', issue: { repository: issue.repository, number: issue.number } });
    }
  }

  const keyOf = (issue: IssueKey): IssueKey => ({ repository: issue.repository, number: issue.number });

  return {
    levels: rows.map((row) => row.map(keyOf)),
    levelOf: (issue) => level.get(issueKeyString(issue)) ?? 0,
    stateOf: (issue) => states.get(issueKeyString(issue)) ?? 'locked',
    unlocks: (issue) => {
      const key = issueKeyString(issue);
      return ordered
        .filter((other) => planBlockers.get(issueKeyString(other))!.some((blocker) => issueKeyString(blocker) === key))
        .map(keyOf);
    },
    ghosts: (issue) => ghostsOf.get(issueKeyString(issue)) ?? [],
    current,
    warnings,
  };
}
