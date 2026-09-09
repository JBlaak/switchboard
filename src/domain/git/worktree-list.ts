/**
 * Parsing `git worktree list --porcelain`.
 *
 * The porcelain format is blank-line separated records, one attribute per line:
 *
 *     worktree /path/to/checkout
 *     HEAD 0123abcd…
 *     branch refs/heads/feat/x     (or the bare word `detached`)
 *     locked [reason]              (optional)
 *     prunable [reason]            (optional)
 *
 * A bare repository prints `worktree <path>` followed by `bare` and nothing
 * else. Parsed here rather than with `--porcelain -z` because the output is
 * also what the user sees in a terminal, so a test fixture can be pasted
 * straight from one.
 */
import type { Worktree } from './types';

/** The record as git prints it, before deciding whether it is a working tree. */
interface RawRecord {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
  locked?: string;
}

/**
 * Every working tree the repository currently has, in the order git printed
 * them.
 *
 * Two kinds of record are dropped because nothing can be launched in them: a
 * `bare` entry has no working tree at all, and a `prunable` one is a directory
 * that has since been deleted (git keeps the bookkeeping until `worktree
 * prune`). `isPrimary` marks the first record git prints, which is the main
 * working tree — so when the main entry is bare, no surviving entry is primary.
 *
 * Tolerates CRLF and a missing final newline, since the text may have passed
 * through a Windows shell or been captured without the trailing newline.
 */
export function parseWorktreeList(stdout: string): Worktree[] {
  const records: RawRecord[] = [];
  let current: RawRecord | null = null;

  for (const rawLine of stdout.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '') {
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = {
        path: stripTrailingSlash(line.slice('worktree '.length)),
        head: '',
        branch: null,
        detached: false,
        bare: false,
        prunable: false,
      };
      records.push(current);
      continue;
    }
    // Attribute lines only mean something inside a record.
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = line.slice('locked'.length).trimStart();
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
  }

  const worktrees: Worktree[] = [];
  records.forEach((record, index) => {
    if (record.bare || record.prunable) return;
    const worktree: Worktree = {
      path: record.path,
      head: record.head,
      branch: record.detached ? null : record.branch,
      isPrimary: index === 0,
      detached: record.detached,
    };
    if (record.locked !== undefined) worktree.locked = record.locked;
    worktrees.push(worktree);
  });
  return worktrees;
}

/** `/a/b/` → `/a/b`, leaving a bare root alone. */
function stripTrailingSlash(path: string): string {
  const stripped = path.replace(/\/+$/, '');
  return stripped === '' ? path.slice(0, 1) : stripped;
}
