/**
 * Where a session worked: every worktree and branch its transcripts were in.
 *
 * A session's footprint is wider than the folder it was started in (D6). Each
 * transcript line records the `cwd` and `gitBranch` it was written from, and a
 * swarm's subagents write their own transcripts from their own worktrees, so
 * the main transcript and every `subagents/*.jsonl` together name each place
 * the session touched.
 */
import { parseTranscriptLine } from '../session/transcript';
import type { WorkLocation } from './model';

/** One transcript's lines, and whether a subagent wrote it. */
export interface TranscriptSource {
  lines: readonly string[];
  fromSubagent: boolean;
}

/**
 * The worktree a `cwd` sits in: the deepest known root that contains it.
 *
 * The deepest, because agent worktrees usually live inside the main checkout
 * (`.claude/worktrees/…`), so the main checkout's root contains them too. A
 * `cwd` under no known root is taken as its own root rather than dropped: it
 * was still somewhere the session worked.
 */
export function worktreeRootOf(cwd: string, worktreeRoots: readonly string[]): string {
  let best: string | null = null;
  for (const root of worktreeRoots) {
    const trimmed = root.replace(/\/+$/, '') || '/';
    const inside = cwd === trimmed || cwd.startsWith(trimmed === '/' ? '/' : trimmed + '/');
    if (inside && (best === null || trimmed.length > best.length)) best = trimmed;
  }
  return best ?? cwd;
}

/**
 * Every `(worktree, branch)` the transcripts were written from, once each, in
 * the order they first appear.
 *
 * A place the main conversation worked in is not a subagent's, even when a
 * subagent was there too: `fromSubagent` only stays true when nothing but
 * subagents went there. A detached HEAD is not a branch anyone can open a PR
 * from, so it is left out.
 */
export function workLocations(
  sources: readonly TranscriptSource[],
  worktreeRoots: readonly string[],
): WorkLocation[] {
  const entries: WorkLocation[] = [];
  for (const source of sources) {
    for (const line of source.lines) {
      const entry = parseTranscriptLine(line) as { cwd?: unknown; gitBranch?: unknown } | null;
      if (!entry || typeof entry.cwd !== 'string' || !entry.cwd) continue;
      if (typeof entry.gitBranch !== 'string' || !entry.gitBranch || entry.gitBranch === 'HEAD') continue;
      entries.push({
        worktree: worktreeRootOf(entry.cwd, worktreeRoots),
        branch: entry.gitBranch,
        fromSubagent: source.fromSubagent,
      });
    }
  }
  return mergeWorkLocations(entries);
}

/**
 * Locations that landed on the same worktree and branch, as one, in the order
 * they first appear. `fromSubagent` stays true only when every one of them
 * was a subagent's.
 *
 * For when the worktree roots are only known after the fact: the transcript
 * store reports each `cwd` as written, git resolves it to its root, and two
 * subdirectories of one worktree become one place.
 */
export function mergeWorkLocations(entries: readonly WorkLocation[]): WorkLocation[] {
  const found = new Map<string, WorkLocation>();
  for (const entry of entries) {
    const key = locationKey(entry.worktree, entry.branch);
    const known = found.get(key);
    if (known) {
      if (!entry.fromSubagent) known.fromSubagent = false;
    } else {
      found.set(key, { ...entry });
    }
  }
  return [...found.values()];
}

/** The identity of a location: two lines in the same worktree on the same branch are one place. */
export function locationKey(worktree: string, branch: string): string {
  return worktree + '\0' + branch;
}
