/**
 * Recognising when a running session becomes a different session.
 *
 * Two things re-key a session mid-flight. A fork (`--resume … --fork-session`)
 * starts writing a new transcript that carries the original's id in its
 * messages. Accepting a plan hands the work to a fresh session that shares the
 * old one's slug. Either way the PTY we are holding is now writing to a file we
 * do not know the name of, and the sidebar row, the MCP server and the stop
 * button all still point at the old id.
 *
 * The matching rules are here; reading the transcripts is the adapter's job.
 */

/** The fork/plan signals read out of the head of a freshly appeared transcript. */
export interface NewSessionSignals {
  forkedFrom: string | null;
  planContent: boolean;
  slug: string | null;
  parentSessionId: string | null;
  hasSnapshots: boolean;
}

/** What the tail of the old transcript says about a plan handover. */
export interface OldSessionTail {
  hasExitPlanMode: boolean;
  slug: string | null;
}

/** One transcript line, as far as transition detection cares about it. */
interface TransitionEntry {
  type?: string;
  slug?: string;
  sessionId?: string;
  planContent?: unknown;
  forkedFrom?: { sessionId?: string };
}

/** The session being tracked, as far as matching cares. */
export interface TrackedSession {
  /** The id the map currently holds it under. */
  sessionId: string;
  /** The session it was forked from, while the fork is unresolved. */
  forkFrom: string | null;
  /** Set once a transition has already re-keyed it. */
  realSessionId?: string;
}

/** How a new transcript relates to the session we are tracking. */
export type TransitionKind = 'fork' | 'plan-accept';

/** A new transcript created within this window of the old one's last write is
 *  close enough to be the same handover. */
export const PLAN_HANDOVER_WINDOW_MS = 30000;

/** How long a signal-less transcript is tolerated before it counts as junk. */
export const STALE_EMPTY_FILE_MS = 3600000;

/** Read the fork/plan signals out of a new transcript's leading lines. */
export function extractNewSessionSignals(lines: string[]): NewSessionSignals {
  const signals: NewSessionSignals = {
    forkedFrom: null, planContent: false, slug: null,
    parentSessionId: null, hasSnapshots: false,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: TransitionEntry;
    try { entry = JSON.parse(line) as TransitionEntry; } catch { continue; }
    // Snapshot lines carry no fork/session signals, and can be tens of KB each.
    if (entry.type === 'file-history-snapshot') { signals.hasSnapshots = true; continue; }
    if (entry.forkedFrom) signals.forkedFrom = entry.forkedFrom.sessionId ?? null;
    if (entry.planContent) signals.planContent = true;
    if (entry.slug && !signals.slug) signals.slug = entry.slug;
    // --fork-session copies messages carrying the original sessionId
    if (entry.sessionId && !signals.parentSessionId) signals.parentSessionId = entry.sessionId;
    // Everything worth reading appears before the first real turn.
    if (entry.type === 'user' || entry.type === 'assistant') break;
  }
  return signals;
}

/** Read the plan-handover signals out of the tail of the old transcript. */
export function extractOldSessionTail(tail: string): OldSessionTail {
  const slugMatches = tail.match(/"slug"\s*:\s*"([^"]+)"/g);
  const last = slugMatches?.[slugMatches.length - 1]?.match(/"slug"\s*:\s*"([^"]+)"/);
  return { hasExitPlanMode: tail.includes('ExitPlanMode'), slug: last ? last[1] : null };
}

/** True when a transcript has said nothing useful yet — still being written. */
export function hasNoSignals(signals: NewSessionSignals): boolean {
  return !signals.forkedFrom && !signals.parentSessionId && !signals.slug && !signals.planContent;
}

/**
 * Does this new transcript belong to the session we are tracking, as a fork?
 *
 * Three shapes count: the file names our id as its origin, it names the session
 * we were forked from (which is what `--fork-session` writes), or it is a fork
 * file with nothing but snapshots in it yet while we are still waiting for one.
 */
export function matchesFork(
  signals: NewSessionSignals,
  session: TrackedSession,
  newSessionId: string,
): boolean {
  if (signals.forkedFrom === session.sessionId) return true;
  if (session.forkFrom && signals.forkedFrom === session.forkFrom) return true;
  if (session.forkFrom && signals.parentSessionId === session.forkFrom && newSessionId !== session.forkFrom) return true;
  if (signals.hasSnapshots && session.forkFrom && !session.realSessionId) return true;
  return false;
}

/**
 * Does this new transcript continue the old one after a plan was accepted?
 *
 * The pair has to share a slug, the new file has to carry plan content, the old
 * one has to end in an ExitPlanMode call, and the two writes have to be close
 * enough together to be the same handover rather than a later session that
 * happened to reuse the slug.
 */
export function matchesPlanAccept(
  signals: NewSessionSignals,
  oldTail: OldSessionTail,
  { oldMtimeMs, newMtimeMs }: { oldMtimeMs: number; newMtimeMs: number },
): boolean {
  if (!signals.planContent || !signals.slug) return false;
  if (!oldTail.hasExitPlanMode || oldTail.slug !== signals.slug) return false;
  return Math.abs(newMtimeMs - oldMtimeMs) < PLAN_HANDOVER_WINDOW_MS;
}

/** Which kind of transition a match represents, for the log line. */
export function transitionKind(signals: NewSessionSignals, session: TrackedSession): TransitionKind {
  return signals.forkedFrom || session.forkFrom ? 'fork' : 'plan-accept';
}
