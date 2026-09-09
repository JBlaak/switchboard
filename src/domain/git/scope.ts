/**
 * The one rule for whether a session belongs to the place the rail has
 * selected.
 *
 * A session carries two paths: `cwd`, the directory it ran in, and
 * `projectPath`, the project it is grouped under. They differ when the session
 * ran in a worktree, and worktrees come in two flavours that the rail must
 * treat alike:
 *
 *  - Claude CLI's `--worktree` checks out into `<project>/.claude/worktrees/<n>`
 *    (or `.claude-worktrees/<n>`, `.worktrees/<n>`). The indexer recognises the
 *    shape (worktreeParentPath) and folds the session into the parent, so its
 *    `projectPath` is already the parent and only `cwd` says which worktree.
 *
 *  - A plain `git worktree add ../feature-x` puts the checkout anywhere. Nothing
 *    about the path says it is a worktree, so today such a session is its own
 *    top-level project — `projectPath` and `cwd` both name the checkout. The
 *    only thing that ties it to the parent is that `git worktree list`, run in
 *    the parent, prints it.
 *
 * Attribution therefore looks at three things — the row's projectPath, the
 * parent's worktree list, and the directory-name convention — and a project is
 * absorbed into another's tile whenever either of the last two claims it, so
 * the same place never appears twice on the rail.
 */
import { worktreeParentPath } from '../project/project-path';
import type { Scope } from './types';

/**
 * One spelling for a path that may come from git (forward slashes, no trailing
 * slash), from a transcript's `cwd` (backslashes on Windows, sometimes a
 * trailing slash) or from settings — they are compared for equality below, so
 * the same directory has to spell itself the same way whichever source it came
 * from.
 */
function normalize(path: string): string {
  const forward = path.replace(/\\/g, '/');
  const stripped = forward.replace(/\/+$/, '');
  return stripped === '' ? forward.slice(0, 1) : stripped;
}

/**
 * Does this session row belong to `scope`?
 *
 * No scope admits everything. A project scope (`worktreePath` null) admits the
 * project's own rows and every row that ran in one of its worktrees, from
 * either flavour: a row is in the project when its projectPath is the project,
 * when its place is in `knownWorktrees` (the parent's `git worktree list`), or
 * when its place has the `.claude/worktrees` shape under the project. A
 * worktree scope narrows that further to rows whose place is that checkout;
 * the primary checkout's path is the project path itself, which is also what a
 * row with no `cwd` falls back to, so rows that never recorded a cwd land on
 * the primary tile.
 *
 * `knownWorktrees` may be empty (git unavailable, or not asked yet); the other
 * two tests still work without it.
 */
export function attributeToScope(
  row: { cwd: string | null; projectPath: string },
  scope: Scope | null,
  knownWorktrees: readonly string[],
): boolean {
  if (scope === null) return true;

  const project = normalize(scope.projectPath);
  const place = normalize(row.cwd ?? row.projectPath);
  const inProject =
    normalize(row.projectPath) === project ||
    knownWorktrees.some(worktree => normalize(worktree) === place) ||
    worktreeParentPath(place) === project;
  if (!inProject) return false;

  if (scope.worktreePath === null) return true;
  return place === normalize(scope.worktreePath);
}

/**
 * The top-level project paths that are really someone else's worktree and
 * should be drawn under that project rather than as a tile of their own.
 *
 * A project is absorbed when another listed project claims it — either its
 * `git worktree list` names the path, or the path has the `.claude/worktrees`
 * shape under the other project. The first path in each worktree list is the
 * main working tree, as git prints it, and is never absorbed by that list:
 * every worktree of a repository prints the same list, so when both `/repo`
 * and `/repo-feature` are projects each one's list names the other, and
 * without that rule they would absorb each other and neither would be drawn.
 * Callers must pass the lists in git's order for this to hold.
 *
 * Returns the paths as they appear in `projectPaths`, so the caller can match
 * them without re-normalising.
 */
export function absorbedProjectPaths(
  projectPaths: readonly string[],
  worktreesByProject: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const projects = new Map<string, string>();
  for (const path of projectPaths) projects.set(normalize(path), path);

  // Every linked (non-primary) worktree some project knows about, with the
  // project that claims it.
  const claimedBy = new Map<string, string>();
  for (const [owner, worktrees] of worktreesByProject) {
    const ownerPath = normalize(owner);
    worktrees.forEach((worktree, index) => {
      const place = normalize(worktree);
      if (index === 0 || place === ownerPath) return;
      claimedBy.set(place, ownerPath);
    });
  }

  const absorbed = new Set<string>();
  for (const [place, original] of projects) {
    const claimant = claimedBy.get(place);
    if (claimant !== undefined && claimant !== place) {
      absorbed.add(original);
      continue;
    }
    const parent = worktreeParentPath(place);
    if (parent !== null && parent !== place && projects.has(parent)) absorbed.add(original);
  }
  return absorbed;
}
