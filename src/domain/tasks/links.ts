/**
 * Which session works on which BlaakTasks task, and in which repo (#245).
 *
 * A link ties a task to a session and the project the session runs in. A task
 * collects sessions over time; a session belongs to at most one task, and a
 * newer link replaces an older one. A link without a session is a repo set by
 * hand: it moves the task's repo and nothing else.
 *
 * The rules here read a task's links however many rows hold them, so they
 * give the same answer whether or not the store has dropped the stale ones.
 */

/** How a link came about: a start from the task, a session's own tool call, or by hand. */
export type TaskLinkSource = 'start' | 'detected' | 'manual';

export interface TaskLink {
  /** The task's Notion page id, as `taskIdFrom` gives it. */
  taskId: string;
  /** The project the session runs in, or the repo set by hand. */
  projectPath: string;
  /** Null for a repo set by hand, which links no session. */
  sessionId: string | null;
  source: TaskLinkSource;
  /** Epoch ms. */
  linkedAt: number;
}

/** A Notion page id: 32 hex digits, dashed or not. */
const PAGE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * A task id in the one form links are kept in (Notion's own: lowercase,
 * dashed), or null when the value cannot be one. A tool call may pass the id
 * either way, and the same task must not end up under two keys.
 */
export function taskIdFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!PAGE_ID.test(trimmed)) return null;
  const hex = trimmed.replace(/-/g, '').toLowerCase();
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** The newest of these links; of two made at the same moment, the later one in the list. */
function latest(links: readonly TaskLink[]): TaskLink | null {
  let best: TaskLink | null = null;
  for (const link of links) if (!best || link.linkedAt >= best.linkedAt) best = link;
  return best;
}

/** The task a session works on: its newest link, or null when it has none. */
export function sessionTask(links: readonly TaskLink[], sessionId: string): TaskLink | null {
  return latest(links.filter((link) => link.sessionId === sessionId));
}

/**
 * The links that still count: each session's newest only, since a newer link
 * replaced the rest, plus a task's newest repo set by hand.
 */
function current(links: readonly TaskLink[]): TaskLink[] {
  const bySession = new Map<string, TaskLink>();
  const byHand = new Map<string, TaskLink>();
  for (const link of links) {
    const [into, key] = link.sessionId === null ? [byHand, link.taskId] : [bySession, link.sessionId];
    const known = into.get(key);
    if (!known || link.linkedAt >= known.linkedAt) into.set(key, link);
  }
  return [...bySession.values(), ...byHand.values()];
}

/**
 * Where a task's work happens: the project of its latest link, a repo set by
 * hand included, or null when it has none. A session that has since moved to
 * another task no longer says anything about this one's repo.
 */
export function taskRepo(links: readonly TaskLink[], taskId: string): string | null {
  return latest(current(links).filter((link) => link.taskId === taskId))?.projectPath ?? null;
}

/** The sessions that work on a task, the most recently linked first. */
export function taskSessions(links: readonly TaskLink[], taskId: string): string[] {
  return current(links)
    .filter((link) => link.taskId === taskId && link.sessionId !== null)
    .sort((a, b) => b.linkedAt - a.linkedAt)
    .map((link) => link.sessionId as string);
}

/**
 * The session that owns a task: of its sessions, the most recently active,
 * as `issueOwners` decides an issue's. `activeAt` answers a session's last
 * activity in epoch ms, or null for one that owns nothing (an archived one).
 * Of two equally active, the more recently linked wins.
 */
export function taskOwner(
  links: readonly TaskLink[],
  taskId: string,
  activeAt: (sessionId: string) => number | null,
): string | null {
  let owner: { sessionId: string; at: number } | null = null;
  for (const sessionId of taskSessions(links, taskId)) {
    const at = activeAt(sessionId);
    if (at === null) continue;
    if (!owner || at > owner.at) owner = { sessionId, at };
  }
  return owner?.sessionId ?? null;
}

/** The tasks whose repo is this project, the most recently linked first. */
export function repoTasks(links: readonly TaskLink[], projectPath: string): string[] {
  const linkedAt = new Map<string, number>();
  for (const link of current(links)) {
    linkedAt.set(link.taskId, Math.max(linkedAt.get(link.taskId) ?? -Infinity, link.linkedAt));
  }
  return [...linkedAt.keys()]
    .filter((taskId) => taskRepo(links, taskId) === projectPath)
    .sort((a, b) => (linkedAt.get(b) ?? 0) - (linkedAt.get(a) ?? 0));
}

/**
 * Whether a task a session's transcript names should become its link. Only
 * when it names a different task than the session has, and named it after
 * that link was made: a link made by hand since is not undone by an older
 * call. A call without a time only counts for a session with no link at all.
 */
export function detectedLinkWins(current: TaskLink | null, detected: { taskId: string; at: number | null }): boolean {
  if (!current) return true;
  if (current.taskId === detected.taskId) return false;
  return detected.at !== null && detected.at > current.linkedAt;
}
