/**
 * One repository, checked out in several places at once.
 *
 * A claim names the file a session asked to write, as an absolute path — and
 * that path is inside whichever checkout the session happened to run in. The
 * Changes list asks about a *different* checkout: the one the user has scoped
 * to. `…/worktrees/agent-a/src/x.ts` and `…/worktrees/m1-rail/src/x.ts` are the
 * same file in two working copies of one repository, and comparing the two
 * absolute paths says they are unrelated.
 *
 * Measured on this repository: scoped to one worktree, 105 changed files
 * produced 6 attributed and 99 in `Generated · not by a session`, because the
 * 99 had been written by sessions running in sibling worktrees. Running several
 * sessions at once is the case this feature exists for, so that ratio is the
 * normal one, not an edge.
 *
 * The rule here is the fix: fold a path to its position *inside its own
 * checkout* before comparing, so `src/x.ts` in one worktree answers for
 * `src/x.ts` in another.
 *
 * **What stops it over-matching** is that a root is never guessed. The caller
 * supplies the checkouts of one repository — the project directory, what
 * `git worktree list` printed for it, and the CLI's own `…/worktrees/<name>`
 * layouts under it — and a path outside all of them keeps its absolute
 * spelling and can only match an identical absolute path. Two unrelated
 * projects that both hold a `src/index.ts` never meet: neither is inside the
 * other's roots.
 *
 * Pure, and separator-agnostic: a `cwd` read out of a transcript is
 * backslash-separated on Windows while git's own paths are not, so both sides
 * are compared on one spelling.
 */

/**
 * The checkouts of one repository, as roots to fold paths against.
 *
 * Deepest first, because a CLI worktree lives *inside* the project it was cut
 * from: `<project>/.claude/worktrees/a/src/x.ts` has to fold to `src/x.ts`
 * against the worktree, not to `.claude/worktrees/a/src/x.ts` against the
 * project. Blanks and duplicates are dropped, so a caller can pass whatever it
 * has without filtering first.
 */
export function checkoutRoots(paths: readonly (string | null | undefined)[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const root = normalizeRoot(path);
    if (root) roots.add(root);
  }
  return [...roots].sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Where this path sits inside one of the checkouts, or null when it sits in
 * none of them.
 *
 * Forward-slashed, exactly as git spells a path relative to a worktree root, so
 * the answer can be compared with one. The root itself is not "inside" itself:
 * a directory is not a changed file.
 */
export function pathWithinCheckout(path: string, roots: readonly string[]): string | null {
  if (!path) return null;
  const target = path.replace(/\\/g, '/');
  for (const root of roots) {
    const prefix = root.endsWith('/') ? root : root + '/';
    if (target.length > prefix.length && target.startsWith(prefix)) {
      return target.slice(prefix.length);
    }
  }
  return null;
}

/**
 * The identity a claim and a question are compared under.
 *
 * Inside a checkout that is the path relative to it, so two checkouts of one
 * repository agree; outside every checkout it is the absolute path itself,
 * which is the behaviour a single-checkout project has always had and the
 * reason an unrelated project cannot be dragged in.
 *
 * Returned as a function because it is applied to every claim in a project's
 * history — thousands of them on every refresh — and the roots only have to be
 * prepared once.
 */
export function checkoutKey(roots: readonly string[]): (path: string) => string {
  if (roots.length === 0) return path => path;
  return path => pathWithinCheckout(path, roots) ?? path;
}

/** Forward-slashed, with any trailing separator dropped; '' for nothing usable. */
function normalizeRoot(path: string | null | undefined): string {
  if (!path) return '';
  const slashed = path.replace(/\\/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}
