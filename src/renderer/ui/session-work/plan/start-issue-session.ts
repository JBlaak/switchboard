/**
 * Starting a session on a plan's issue (A2, A3), from the renderer's side.
 *
 * Main makes the worktree and the prompt (`prepareIssueWorktree`); the
 * session is started here, because its row is the renderer's to make. It
 * starts with the project's usual session options, minus `--worktree` (it is
 * in one already), and with the prompt as the CLI's first prompt.
 *
 * Kept free of the terminal and the DOM, so the sequence is tested in node
 * with fakes; `actions.ts` hands it the real steps.
 */
import type { IssueKey, Plan } from '../../../../domain/plan/model';
import type { IssueSessionStart, IssueWorktreeRequest, IssueWorktreeResult } from '../../../../domain/plan/issue-session';
import type { SessionOptions } from '../../../../domain/launch/session-options';

export interface StartIssueSessionSteps {
  prepare(request: IssueWorktreeRequest): Promise<IssueWorktreeResult>;
  /** The options a new session in this project starts with by default. */
  defaultOptions(projectPath: string): Promise<SessionOptions>;
  /** Start a Claude session in a directory, put it on screen, and answer its id. */
  launch(projectPath: string, options: SessionOptions): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }>;
}

export interface StartIssueSessionRequest {
  /** The project the plan is shown for: the worktree goes under its repository. */
  projectPath: string;
  issue: IssueKey;
  plan: Plan;
}

export async function startIssueSessionWith(
  steps: StartIssueSessionSteps, { projectPath, issue, plan }: StartIssueSessionRequest,
): Promise<IssueSessionStart> {
  let prepared: IssueWorktreeResult;
  try {
    prepared = await steps.prepare({ projectPath, issue, plan });
  } catch (err) {
    return { ok: false, reason: (err as Error).message || 'Could not prepare the worktree' };
  }
  if (!prepared.ok) return prepared;

  // The session is in its worktree already; `--worktree` would make another.
  const { worktree: _worktree, worktreeName: _worktreeName, ...defaults } = await steps.defaultOptions(projectPath);
  const launched = await steps.launch(prepared.worktreePath, { ...defaults, initialPrompt: prepared.prompt });
  if (!launched.ok) return launched;
  return prepared.warning
    ? { ok: true, sessionId: launched.sessionId, warning: prepared.warning }
    : { ok: true, sessionId: launched.sessionId };
}
