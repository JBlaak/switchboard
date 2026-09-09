/**
 * Where a file sits, worked out without a DOM.
 *
 * The code area asks two questions about every file it opens — which crumbs to
 * put in the header, and which absolute path to hand the watcher and the
 * copy-path button — and neither needs an element. They live here for the same
 * reason `rail-model.ts` is separate from the rail: this is the part with
 * decisions in it, so it is the part worth testing directly, and it imports
 * nothing that touches `document`.
 *
 * Everything here is tolerant, because a path arrives from a tree, an OS or a
 * hand-written string: `\` separators, a leading `./` or `/`, doubled
 * separators, and a "relative" path that is really the absolute one.
 */

/** One or more separators of either flavour. */
const SEPARATORS = /[\\/]+/;

/** A path that names its own root: POSIX `/…`, UNC `\\…`, or `C:…`. */
const ABSOLUTE = /^([\\/]|[A-Za-z]:)/;

/** Split a path into bare segments, dropping empties and `.` steps. */
function segmentsOf(path: string): string[] {
  return path.split(SEPARATORS).filter(segment => segment !== '' && segment !== '.');
}

/**
 * The crumbs for a file, from just below the worktree root down to its name.
 *
 * A path that arrives already absolute is reduced to the part below the
 * worktree, so a caller holding the full path gets the same crumbs as one
 * holding the relative path instead of a breadcrumb of the whole disk. The
 * reduction only applies to a path that names a root: a relative path whose
 * first segments happen to repeat the worktree's is left alone, since it is
 * genuinely relative and nesting is the more likely reading.
 *
 * An absolute path outside the worktree keeps all of its segments — there is no
 * shorter true answer, and silently showing only the tail would hide where the
 * file actually came from.
 */
export function breadcrumbSegments(worktreePath: string, relPath: string): string[] {
  const parts = segmentsOf(relPath);
  if (!ABSOLUTE.test(relPath)) return parts;

  const root = segmentsOf(worktreePath);
  const insideWorktree = root.length > 0
    && parts.length >= root.length
    && root.every((segment, i) => segment === parts[i]);

  return insideWorktree ? parts.slice(root.length) : parts;
}

/**
 * The worktree root and a file inside it, joined the way the host writes paths.
 *
 * The separator is taken from the worktree rather than assumed, because the
 * renderer has no `path` module and a Windows worktree fed back a POSIX-joined
 * path would not match the one the file watcher echoes on change.
 */
export function absolutePathFor(worktreePath: string, relPath: string): string {
  const rest = breadcrumbSegments(worktreePath, relPath);

  // An absolute path the worktree does not contain is already the answer:
  // nothing was reduced, so rooting it under the worktree would name a file
  // that is not there.
  if (ABSOLUTE.test(relPath) && rest.length === segmentsOf(relPath).length) return relPath;

  const separator = worktreePath.includes('\\') ? '\\' : '/';
  const root = worktreePath.replace(/[\\/]+$/, '');
  return rest.length ? root + separator + rest.join(separator) : root;
}
