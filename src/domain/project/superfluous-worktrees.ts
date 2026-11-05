/**
 * Which of a project's worktrees its page's Clean button removes: the ones
 * whose work has landed and that hold nothing else. A linked worktree, not
 * locked, without uncommitted changes, on a branch merged into the default
 * branch, and with no Claude session running in it. Its branch is kept, so
 * `git worktree add` brings the checkout back.
 */
import type {WorktreeOverview} from './overview';

/** The worktrees among `worktrees` that Clean removes, in order. */
export function superfluousWorktrees<W extends WorktreeOverview>(worktrees: readonly W[]): W[] {
    return worktrees.filter(
        (worktree) =>
            !worktree.main &&
            !worktree.locked &&
            worktree.changedFiles === 0 &&
            worktree.merged &&
            worktree.running.length === 0,
    );
}
