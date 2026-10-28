/**
 * What Switchboard writes to a task on its own, and when it offers more (#247).
 *
 * Only what it knows for certain: a session started from the task (In
 * progress, starred for today), each PR the session opens, the archive. Done
 * is never written on its own; archiving a session offers it, and only when
 * you archived it and every PR it opened is merged.
 */
import type { SessionPullRequest } from '../session/session';
import type { TaskPatch } from './model';

/** A PR's state as `PrWatchService` last heard it from `gh`. */
export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

/** One call to BlaakTasks, as the writes service sends and queues it. */
export type TaskWrite =
  | { kind: 'update'; taskId: string; patch: TaskPatch }
  | { kind: 'progress'; taskId: string; text: string; pullRequest?: string };

/** A session started from the task: it is being worked on, today. */
export const STARTED_PATCH: Readonly<TaskPatch> = Object.freeze({ status: 'In progress', today: true });

/** The one patch that marks a task done, sent only when you press for it. */
export const DONE_PATCH: Readonly<TaskPatch> = Object.freeze({ status: 'Done' });

/** The progress line for a PR the session opened. */
export function openedPullRequestLine(pr: Pick<SessionPullRequest, 'number'>): string {
  return `Opened PR #${pr.number}`;
}

/** The progress line for an archived session. */
export const SESSION_ARCHIVED_LINE = 'Session archived';

/**
 * Whether every PR is merged, as far as is known. A PR whose state is unknown
 * (`gh` never answered about it) counts as not merged, and so does one closed
 * without merging. No PRs at all is not "all merged": there is nothing to
 * show the work landed.
 */
export function allMerged(
  pullRequests: readonly Pick<SessionPullRequest, 'url'>[],
  stateOf: (url: string) => PullRequestState | null | undefined,
): boolean {
  if (pullRequests.length === 0) return false;
  return pullRequests.every((pr) => stateOf(pr.url) === 'merged');
}

/**
 * Whether archiving a task's session offers Mark done: only when you archived
 * it (a session archiving itself never asks) and every PR it opened is merged.
 */
export function offersMarkDone(
  archive: { byUser: boolean },
  pullRequests: readonly Pick<SessionPullRequest, 'url'>[],
  stateOf: (url: string) => PullRequestState | null | undefined,
): boolean {
  return archive.byUser && allMerged(pullRequests, stateOf);
}
