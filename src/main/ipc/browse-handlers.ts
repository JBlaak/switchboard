/**
 * Browsing a project's code: worktrees, the file tree, and what changed.
 *
 * The diff of a single file follows in a later milestone; `getChanges` is the
 * list above the tree.
 */
import { INVOKE } from '../../ipc/channels';
import { resolveClaimPath } from '../../domain/attribution/claims';
import type { ChangesPayload } from '../../domain/changes/types';
import type { DiffBase } from '../../domain/git/types';
import type { SessionClaim } from '../../domain/attribution/types';
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

  // ── What changed, and who changed it ──
  ipc.handle(INVOKE.getChanges, (worktreePath: string, projectPath: string, base: DiffBase) =>
    changesIn(app, worktreePath, projectPath, base));
}

/**
 * Git first, attribution second, over exactly the paths git reported.
 *
 * The order is the rule. A `tool_use` in a transcript is what a session *asked*
 * to write — a rejected diff and a later revert both leave the claim behind —
 * so the transcripts can only ever narrow git's answer, never widen it. Asking
 * attribution for the paths git named is what performs that intersection: a
 * claim on a path git does not report never reaches the renderer, and a path
 * nothing claims arrives with no entry in `claims`, which is the
 * `Generated · not by a session` group.
 */
async function changesIn(
  app: Container, worktreePath: string, projectPath: string, base: DiffBase,
): Promise<ChangesPayload> {
  const diff = await app.git.changedFiles(worktreePath, base);

  // Git spells its paths relative to the worktree; a claim is an absolute path
  // resolved against the transcript entry's own cwd. `resolveClaimPath` is the
  // one that made those, so it is the one that has to make these — anything
  // else would compare two spellings of the same file and match neither. The
  // worktree, not the project, is the root: a checkout under
  // `.claude/worktrees` holds its own copy of `src/app.ts`.
  //
  // An `ssh://` worktree has no absolute local path to build, so nothing there
  // matches a claim and every file lands in the unclaimed group. That is the
  // honest answer for now: the transcripts of a remote session are written on
  // the far host, and this process has never read them.
  const absolute = new Map<string, string>();
  for (const file of [...diff.files, ...diff.untracked]) {
    absolute.set(file.path, resolveClaimPath(worktreePath, file.path));
  }

  // The *project* decides which transcript folders are worth reading — a
  // worktree's sessions are folded into the repository it was cut from, so
  // scoping the search to the worktree would miss them.
  const claimed = await app.attribution.claimsFor(projectPath, [...absolute.values()]);

  const claims: Record<string, SessionClaim[]> = {};
  for (const [relPath, path] of absolute) {
    const found = claimed.get(path);
    if (found) claims[relPath] = found.sessions;
  }
  return { ...diff, claims };
}
