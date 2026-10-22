/**
 * Start level (A1): one session for the plan's current level, which runs an
 * agent per Ready issue and governs them.
 *
 * Each issue gets its worktree the way Start session makes one (#125's
 * `prepare`), one after another: each makes a worktree in the same
 * repository, and git's worktree list wants one change at a time. Then one
 * session starts in the project, with every worktree added to it and a
 * prompt that hands each issue to its own agent (`levelSessionPrompt`).
 *
 * `startLevelWith` is the sequence alone, tested in node with fakes;
 * `issue-actions` hands it the real steps.
 */
import type { IssueKey, Plan, PlanLayout } from '../../../../domain/plan/model';
import type { IssueWorktreeResult } from '../../../../domain/plan/issue-session';
import { levelSessionPrompt, type LevelAgent } from '../../../../domain/plan/start';
import type { StartIssueSessionSteps } from './start-issue-session';

export interface LevelStartReport {
  /** How many issues got an agent in the level's session. */
  started: number;
  failed: { issue: IssueKey; reason: string }[];
  /** The level's session, when it started. */
  sessionId?: string;
}

export interface StartLevelRequest {
  /** The project the plan is shown for: the worktrees go under its repository, and the session starts in it. */
  projectPath: string;
  plan: Plan;
  level: number;
  issues: readonly IssueKey[];
}

/** The issues Start level starts on `level`: its Ready ones, in row order. */
export function readyOnLevel(layout: PlanLayout, level: number): IssueKey[] {
  return (layout.levels[level - 1] ?? []).filter(issue => layout.stateOf(issue) === 'ready');
}

/**
 * Make each issue's worktree in turn, a failure or a throw noted while the
 * rest go on; then start the one session on the worktrees that were made. The
 * session stays in the background, so the plan view stays on screen.
 */
export async function startLevelWith(
  steps: StartIssueSessionSteps, { projectPath, plan, level, issues }: StartLevelRequest,
): Promise<LevelStartReport> {
  const agents: LevelAgent[] = [];
  const failed: LevelStartReport['failed'] = [];
  for (const issue of issues) {
    let prepared: IssueWorktreeResult;
    try {
      prepared = await steps.prepare({ projectPath, issue, plan });
    } catch (err) {
      prepared = { ok: false, reason: (err as Error)?.message || 'Could not prepare the worktree' };
    }
    if (prepared.ok) agents.push({ issue, worktreePath: prepared.worktreePath, branch: prepared.branch, prompt: prepared.prompt });
    else failed.push({ issue, reason: prepared.reason });
  }
  if (!agents.length) return { started: 0, failed };

  // The session governs from the project; `--worktree` would make it one of its own.
  const { worktree: _worktree, worktreeName: _worktreeName, ...defaults } = await steps.defaultOptions(projectPath);
  const addDirs = [defaults.addDirs, ...agents.map(agent => agent.worktreePath)].filter(Boolean).join(',');
  const initialPrompt = levelSessionPrompt(plan, level, agents);
  let launched: Awaited<ReturnType<StartIssueSessionSteps['launch']>>;
  try {
    launched = await steps.launch(projectPath, { ...defaults, addDirs, initialPrompt }, { show: false });
  } catch (err) {
    launched = { ok: false, reason: (err as Error)?.message || 'Could not start the session' };
  }
  if (!launched.ok) {
    const reason = 'The session didn’t start: ' + launched.reason;
    return { started: 0, failed: [...agents.map(({ issue }) => ({ issue, reason })), ...failed] };
  }
  return { started: agents.length, failed, sessionId: launched.sessionId };
}

/** What the plan view says once the level's session came back. */
export function levelStartLine(report: { started: number; failed: readonly unknown[] }): string {
  const total = report.started + report.failed.length;
  const agents = (n: number) => (n === 1 ? '1 agent' : `${n} agents`);
  if (!report.failed.length) return `Started a session with ${agents(report.started)}.`;
  if (!report.started) return 'The session didn’t start.';
  return `Started a session with ${report.started} of ${agents(total)}.`;
}
