/**
 * Which of the worktrees an archived session worked in can be removed.
 *
 * Removing one must lose nothing that cannot be had back: its branch is kept,
 * so its commits stay, and `git worktree add` brings the checkout back. What
 * would be lost is what is in the directory and nowhere else — uncommitted
 * changes, and commits on a detached HEAD that no branch points at — so those
 * keep it. So does being the main checkout, being locked, and another session
 * still working in it.
 */
import type { WorktreeSummary } from '../project/overview';

export type WorktreeVerdict =
  | { path: string; remove: true }
  | { path: string; remove: false; reason: string };

/**
 * A verdict for each of `worked`, in order.
 *
 * `checkouts` is what git lists for the repository; a worktree it does not
 * list is not one git knows, and is left alone. `inUse` holds the directories
 * other sessions work in: one inside a worktree keeps it.
 */
export function worktreeVerdicts(
  worked: readonly string[],
  checkouts: readonly WorktreeSummary[],
  inUse: readonly string[],
): WorktreeVerdict[] {
  return worked.map((path): WorktreeVerdict => {
    const reason = keepReason(path, checkouts.find((checkout) => checkout.path === path), inUse);
    return reason ? { path, remove: false, reason } : { path, remove: true };
  });
}

function keepReason(path: string, checkout: WorktreeSummary | undefined, inUse: readonly string[]): string | null {
  if (!checkout) return 'not a worktree git lists';
  if (checkout.main) return 'the main checkout';
  if (checkout.locked) return 'locked';
  if (checkout.branch === null) return 'on a detached HEAD';
  if (checkout.changedFiles > 0) return 'has uncommitted changes';
  if (inUse.some((dir) => dir === path || dir.startsWith(path + '/'))) return 'another session works in it';
  return null;
}
