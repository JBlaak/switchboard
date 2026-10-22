/**
 * A folder someone is about to add as a project: what main found there, and
 * the rules for reading a path the way it was typed.
 *
 * The Projects modal checks a pasted or typed path as it goes (#171): does it
 * exist, is it a git repository, is that repository on GitHub. It also
 * completes the path on Tab. Both start from text that may begin with `~`,
 * which only the main process can expand, so the rules for that live here.
 */

/** What main found at a candidate project folder. */
export interface ProjectFolderCheck {
  /** The path as asked for, with a leading `~` expanded: what adding it would add. */
  readonly path: string;
  readonly exists: boolean;
  readonly directory: boolean;
  /** Inside a git worktree. */
  readonly git: boolean;
  /** The branch checked out there; null outside git or on a detached HEAD. */
  readonly branch: string | null;
  /** `owner/name` when the repository's origin is on github.com; null otherwise. */
  readonly gitHubRepository: string | null;
  /**
   * The text as typed, completed as far as the folders beside it agree, or
   * null when there is nothing to add. A single match ends in `/`.
   */
  readonly completion: string | null;
}

/** `~` and `~/…` become the home folder; anything else is returned as it is. */
export function expandHome(typed: string, home: string): string {
  if (typed === '~') return home;
  if (typed.startsWith('~/')) return home.replace(/\/+$/, '') + typed.slice(1);
  return typed;
}

/**
 * Where to look to complete `typed`, and the start of the name to complete:
 * the folder up to the last `/`, and what follows it. `~` alone completes to
 * `~/` and so looks in the home folder with nothing typed yet.
 */
export function completionTarget(typed: string): { folder: string; prefix: string } | null {
  if (typed === '~') return { folder: '~/', prefix: '' };
  const slash = typed.lastIndexOf('/');
  if (slash === -1) return null;
  return { folder: typed.slice(0, slash + 1), prefix: typed.slice(slash + 1) };
}

/**
 * `typed`, completed against the folder names found where it points.
 *
 * Hidden folders only count once a `.` has been typed. One match completes
 * to its whole name and a `/`; several complete to as much as they share.
 * Null when that adds nothing.
 */
export function completePath(typed: string, folderNames: readonly string[]): string | null {
  const target = completionTarget(typed);
  if (!target) return null;
  const { folder, prefix } = target;
  const matches = folderNames
    .filter(name => name.startsWith(prefix) && (prefix.startsWith('.') || !name.startsWith('.')))
    .sort();
  if (matches.length === 0) return null;

  const completed = matches.length === 1 ? matches[0] + '/' : commonPrefix(matches);
  const result = folder + completed;
  return result === typed ? null : result;
}

function commonPrefix(names: readonly string[]): string {
  let prefix = names[0];
  for (const name of names) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
