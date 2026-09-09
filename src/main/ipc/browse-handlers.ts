/**
 * Browsing a project's code: worktrees and the file tree now; the diff follows
 * in a later milestone.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerBrowseHandlers(ipc: IpcRegistrar, app: Container): void {
  // ── Git ──
  ipc.handle(INVOKE.gitWorktrees, (projectPath: string) => app.git.worktrees(projectPath));

  // ── The file tree ──
  // Both take a path relative to the worktree rather than an absolute one:
  // the service is the only thing that turns the two into a real path, which
  // is what lets it refuse one that would leave the project.
  ipc.handle(INVOKE.listDir, (worktreePath: string, relPath: string) =>
    app.browse.listDir(worktreePath, relPath));
  ipc.handle(INVOKE.readProjectFile, (worktreePath: string, relPath: string) =>
    app.browse.readFile(worktreePath, relPath));
}
