/**
 * Your review of a PR on the Session work page (C1–C5): which lines can take
 * a comment, where each review thread and pending comment is drawn, and what
 * the three ways of finishing a pending review submit.
 *
 * A comment is anchored the way GitHub anchors it — a line number on one side
 * of the diff — so a thread is drawn under the row that has that number on
 * that side. A thread whose line is no longer in the diff (outdated, or on the
 * file as a whole) has no row, and is listed at the top of its file instead.
 */
import { commentAnchor } from './diff';
import type {
  DiffLine, DiffSide, FileDiff, GitHubAvailability, PullRequestStatus, ReviewThread, WorkItem,
} from './model';

/** Add a line comment to your pending review on a PR item of the session's open page. */
export interface CommentRequest {
  sessionId: string;
  itemId: string;
  path: string;
  line: number;
  side: DiffSide;
  body: string;
}

/**
 * Finish your pending review: `fix` submits it as Request changes and hands
 * its threads to Claude, `submit` submits it as a comment, `discard` deletes it.
 */
export type ReviewMode = 'fix' | 'submit' | 'discard';

export interface ReviewRequest {
  sessionId: string;
  itemId: string;
  mode: ReviewMode;
}

/** Done, or refused with why, shown where it was asked. */
export type ReviewResult = { ok: true } | { ok: false; reason: string };

/** How a submitted review reads on GitHub. */
export type ReviewEvent = 'REQUEST_CHANGES' | 'COMMENT';

export function submitEvent(mode: Exclude<ReviewMode, 'discard'>): ReviewEvent {
  return mode === 'fix' ? 'REQUEST_CHANGES' : 'COMMENT';
}

/**
 * Can this item's diff take line comments (C1)? Only a PR's, only while it is
 * open, and only with `gh` to post them.
 */
export function canComment(item: WorkItem, gh: GitHubAvailability): item is Extract<WorkItem, { kind: 'pr' }> {
  return gh === 'ok' && item.kind === 'pr' && (item.pr.state === 'open' || item.pr.state === 'draft');
}

/** One place on a diff a comment can sit: a line number on one side. */
export function anchorKey(line: number, side: DiffSide): string {
  return side + ':' + line;
}

/**
 * Every anchor a diff line answers to. A new comment on it takes the first
 * (`commentAnchor`); a context line is on both sides, and GitHub lets a
 * comment on it be on either, so a thread on its old number finds it too.
 */
export function lineAnchorKeys(line: DiffLine): string[] {
  const own = commentAnchor(line);
  const keys = [anchorKey(own.line, own.side)];
  if (line.kind === 'context' && line.oldLine !== null) keys.push(anchorKey(line.oldLine, 'LEFT'));
  return keys;
}

/** Anything anchored like a comment. */
export interface Anchored {
  path: string;
  line: number | null;
  side: DiffSide;
}

/** Where a file's threads (or pending comments) are drawn. */
export interface Placement<T> {
  /** By the anchor key of the line they are drawn under (its first, `lineAnchorKeys(line)[0]`). */
  byLine: Map<string, T[]>;
  /** On this file, but on no line of its diff: listed at the top of the file. */
  outdated: T[];
}

/** Sort a file's threads or comments under the lines they are on, in the order given. */
export function placeOnFile<T extends Anchored>(file: FileDiff, items: readonly T[]): Placement<T> {
  const byLine = new Map<string, T[]>();
  const outdated: T[] = [];
  const mine = items.filter((item) => item.path === file.path);
  if (mine.length === 0) return { byLine, outdated };

  // Each anchor to the line it is drawn under; the first line to claim one keeps it.
  const home = new Map<string, string>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const keys = lineAnchorKeys(line);
      for (const key of keys) if (!home.has(key)) home.set(key, keys[0]);
    }
  }
  for (const item of mine) {
    const at = item.line === null ? undefined : home.get(anchorKey(item.line, item.side));
    if (at === undefined) {
      outdated.push(item);
      continue;
    }
    const list = byLine.get(at) ?? [];
    list.push(item);
    byLine.set(at, list);
  }
  return { byLine, outdated };
}

/** The open threads a Fix comments would hand over, or just these when named. */
export function threadsToFix(pr: PullRequestStatus, threadIds?: readonly string[]): ReviewThread[] {
  const open = (pr.threads ?? []).filter((thread) => !thread.resolved);
  if (!threadIds) return open;
  const wanted = new Set(threadIds);
  return open.filter((thread) => wanted.has(thread.id));
}

/** "Review in progress · 2 pending". */
export function pendingLabel(count: number): string {
  return `Review in progress · ${count} pending`;
}

/** Up to two letters for an author's avatar: `jane-doe` → `JD`, `octocat` → `OC`, `dependabot[bot]` → `DE`. */
export function initials(login: string): string {
  const name = login.replace(/\[bot\]$/, '');
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : name.slice(0, 2);
  return letters.toUpperCase() || '?';
}
