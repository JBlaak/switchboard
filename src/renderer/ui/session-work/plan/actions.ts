/**
 * What the Plan tab does with sessions (A1, A2, S1): start one on an issue,
 * jump to the one that owns an issue, and ask which sessions own which.
 *
 * The Plan tab's components (#124) call these and nothing else.
 */
import { openSession, startClaudeSessionIn } from '../../../features/sessions/session-actions';
import { resolveDefaultSessionOptions } from '../../../features/dialogs/launch-options';
import { sessionMap } from '../../../state/session-store';
import { startIssueSessionWith, type StartIssueSessionRequest } from './start-issue-session';
import type { IssueSessionStart } from '../../../../domain/plan/issue-session';

/**
 * Start a session on a plan's issue: a worktree on a branch named after it,
 * Claude started there with the project's usual options and the issue's
 * prompt, and put on screen (unless `show: false`, as Start level asks).
 * Locked issues stack on their blocker's PR (A3).
 *
 * Answers the new session's id, with a warning to show when it started but
 * not as asked (no blocker PR to stack on, a fetch that failed); or why it
 * did not start.
 */
export function startIssueSession(request: StartIssueSessionRequest): Promise<IssueSessionStart> {
  return startIssueSessionWith({
    prepare: (prepare) => window.api.prepareIssueWorktree(prepare),
    defaultOptions: resolveDefaultSessionOptions,
    launch: (projectPath, options, how) => startClaudeSessionIn(projectPath, options, how),
  }, request);
}

/** Put a session on screen, the way a click on its row does. False when no row goes by that id. */
export async function jumpToSession(sessionId: string): Promise<boolean> {
  const session = sessionMap.get(sessionId);
  if (!session) return false;
  await openSession(session);
  return true;
}

/** `owner/repo#n` → the id of the session that owns it (S1); empty when main could not say. */
export async function loadIssueSessions(repository: string): Promise<Record<string, string>> {
  try {
    return await window.api.issueSessions(repository);
  } catch {
    return {};
  }
}
