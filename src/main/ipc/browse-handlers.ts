/**
 * Browsing a project's code: worktrees now; directory listing and the diff
 * follow in later milestones.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerBrowseHandlers(ipc: IpcRegistrar, app: Container): void {
  // ── Git ──
  ipc.handle(INVOKE.gitWorktrees, (projectPath: string) => app.git.worktrees(projectPath));
}
