/**
 * Sessions on a plan's issues (#125): which session owns each issue, and the
 * worktree a new one starts in.
 */
import { INVOKE } from '../../ipc/channels';
import type { IssueWorktreeRequest } from '../../domain/plan/issue-session';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerIssueSessionHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.planIssueSessions, (repository: string) => app.issueSessions.issueSessions(String(repository ?? '')));
  ipc.handle(INVOKE.planPrepareIssueWorktree, (request: IssueWorktreeRequest) => {
    const { projectPath, issue, plan } = request ?? ({} as Partial<IssueWorktreeRequest>);
    if (typeof projectPath !== 'string' || !issue || typeof issue.number !== 'number' || !plan || !Array.isArray(plan.issues)) {
      return { ok: false, reason: 'Not a request to start a session on an issue' };
    }
    return app.issueSessions.prepareIssueWorktree({ projectPath, issue, plan });
  });
}
