/**
 * Rows invented before Claude has written a transcript.
 *
 * A pending row exists so there is something on screen while the CLI starts up.
 * It earns that place only while a real session might still turn up: once the
 * PTY is gone and no file was ever written, nothing is coming.
 *
 * Nothing used to evict those. A session that died before its first turn — a
 * CLI that refused its --session-id, a pre-launch command that failed — left a
 * row pinned to the Working tier (itself exempt from truncation) carrying a
 * client-side `archived: 0` that the archive filter, which reads the injected
 * object rather than the store, could never hide. The row was unremovable, and
 * clicking it only relaunched the same dead id.
 */
import type { SessionRow } from './session';

/** A row the renderer is holding open on the CLI's behalf. */
export interface PendingSession {
  session: SessionRow;
  projectPath: string;
  folder: string;
  /** When the PTY exited, if it did — starts the abandonment grace period. */
  exitedAt?: number;
}

/** The circumstances that keep a pending row alive. */
export interface PendingAbandonOptions {
  /** A PTY is still running under this id. */
  running?: boolean;
  /** The user is looking at it, so its exit banner should stay readable. */
  onScreen?: boolean;
  now?: number;
}

/** How long a pending row is kept before it counts as abandoned. */
export const PENDING_GRACE_MS = 60000;

export function isPendingAbandoned(
  pending: PendingSession,
  { running = false, onScreen = false, now = Date.now() }: PendingAbandonOptions = {},
): boolean {
  // Plain terminals are torn down explicitly on process exit, and a remote row
  // is meant to outlive its connection — archive is the only thing that should
  // ever drop one.
  const type = pending.session.type;
  if (type === 'terminal' || type === 'remote') return false;
  // Still running, or still on screen with its exit banner: leave it be.
  if (running || onScreen) return false;
  if (pending.exitedAt) return now - pending.exitedAt > PENDING_GRACE_MS;
  // No exit was seen, but nothing is running under that id either — the event
  // went missing (a reload mid-launch, an openTerminal that failed). Age from
  // creation so a slow first launch still gets its grace period.
  const created = new Date(pending.session.created).getTime();
  return Number.isFinite(created) && now - created > PENDING_GRACE_MS;
}
