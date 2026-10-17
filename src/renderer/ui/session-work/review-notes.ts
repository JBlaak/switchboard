/**
 * What a file of a PR's diff draws besides its lines: the review threads and
 * your pending comments under the lines they are on, the composer under the
 * line it was opened on, and the threads whose line is gone at the top (#77).
 *
 * Pure, so the placement is tested in node; `DiffRows` looks each row's notes
 * up by its line's anchor key.
 */
import { lineAnchorKeys, placeOnFile } from '../../../domain/session-work/review';
import type { DiffLine, FileDiff, PendingComment, PullRequestStatus, ReviewThread } from '../../../domain/session-work/model';
import type { CommentTarget } from '../../state/session-work-slice';

/** What is drawn under one line. */
export interface LineNotes {
  readonly threads: readonly ReviewThread[];
  readonly pending: readonly PendingComment[];
  /** The composer is open on this line. */
  readonly composer: boolean;
}

/** One file's review, as its rows draw it. */
export interface FileReview {
  readonly itemId: string;
  /** Lines take a `+` and `c` (C1): an open PR, with `gh`. */
  readonly commentable: boolean;
  /** By the anchor key of the line they go under (`noteKey`). */
  readonly notes: ReadonlyMap<string, LineNotes>;
  /** Threads on this file whose line is no longer in the diff, or that are on the file as a whole. */
  readonly outdated: readonly ReviewThread[];
  /** Your pending comments on lines no longer in the diff. */
  readonly outdatedPending: readonly PendingComment[];
}

/** The key a line's notes are filed under. */
export function noteKey(line: DiffLine): string {
  return lineAnchorKeys(line)[0];
}

/**
 * A file's review: nothing for a file no thread, comment or composer is on
 * and that cannot take a comment, so a plain diff draws exactly as before.
 */
export function fileReview(
  itemId: string,
  file: FileDiff,
  pr: PullRequestStatus | null,
  commentable: boolean,
  composer: CommentTarget | null,
): FileReview | null {
  const threads = placeOnFile(file, pr?.threads ?? []);
  const pending = placeOnFile(file, pr?.pendingReview ?? []);
  const open = composer && composer.itemId === itemId && composer.path === file.path
    ? placeOnFile(file, [composer]).byLine.keys().next().value ?? null
    : null;
  if (!commentable && threads.byLine.size === 0 && threads.outdated.length === 0 && pending.byLine.size === 0
    && pending.outdated.length === 0) {
    return null;
  }

  const notes = new Map<string, LineNotes>();
  const keys = new Set([...threads.byLine.keys(), ...pending.byLine.keys(), ...(open ? [open] : [])]);
  for (const key of keys) {
    notes.set(key, {
      threads: threads.byLine.get(key) ?? [],
      pending: pending.byLine.get(key) ?? [],
      composer: key === open,
    });
  }
  return { itemId, commentable, notes, outdated: threads.outdated, outdatedPending: pending.outdated };
}
