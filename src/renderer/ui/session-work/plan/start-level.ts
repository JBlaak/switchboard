/**
 * Start level (A1): one session per Ready issue on the plan's current level,
 * started one after another through #125's `startIssueSession`.
 *
 * One after another rather than all at once: each start makes a worktree in
 * the same repository and puts its session on screen, and git's worktree list
 * and the screen both want one change at a time.
 *
 * `startLevelWith` is the sequence alone, tested in node with a fake start;
 * `issue-actions` hands it the real one.
 */
import type { IssueKey, PlanLayout } from '../../../../domain/plan/model';
import type { IssueSessionStart } from '../../../../domain/plan/issue-session';

export interface LevelStartReport {
  started: number;
  failed: { issue: IssueKey; reason: string }[];
}

/** The issues Start level starts on `level`: its Ready ones, in row order. */
export function readyOnLevel(layout: PlanLayout, level: number): IssueKey[] {
  return (layout.levels[level - 1] ?? []).filter(issue => layout.stateOf(issue) === 'ready');
}

/** Start each issue in turn, waiting for one before the next; a failure or a throw is noted and the rest go on. */
export async function startLevelWith(
  start: (issue: IssueKey) => Promise<IssueSessionStart>, issues: readonly IssueKey[],
): Promise<LevelStartReport> {
  const report: LevelStartReport = { started: 0, failed: [] };
  for (const issue of issues) {
    let result: IssueSessionStart;
    try {
      result = await start(issue);
    } catch (err) {
      result = { ok: false, reason: (err as Error)?.message || 'Could not start the session' };
    }
    if (result.ok) report.started++;
    else report.failed.push({ issue, reason: result.reason });
  }
  return report;
}

/** What the plan view says once a level's starts came back. */
export function levelStartLine(report: { started: number; failed: readonly unknown[] }): string {
  const total = report.started + report.failed.length;
  const sessions = (n: number) => (n === 1 ? '1 session' : `${n} sessions`);
  if (!report.failed.length) return `Started ${sessions(report.started)}.`;
  if (!report.started) return total === 1 ? 'The session didn’t start.' : `None of the ${total} sessions started.`;
  return `Started ${report.started} of ${sessions(total)}.`;
}
