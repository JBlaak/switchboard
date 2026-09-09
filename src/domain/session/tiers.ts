/**
 * How a session row is ranked, and whether it survives the sidebar's truncation.
 *
 * Pure on purpose: the caller reads the live signals out of whatever store it
 * keeps them in and hands them over, so these rules can be tested without a DOM
 * or a renderer state module.
 */

// Sort tiers, highest first. The active block is split by what the session
// wants from the user: first the ones blocking on input, then the ones that
// finished and haven't been read, then the ones still working. Those three
// always outrank pinned and plain recent rows regardless of age.
export const TIER_ATTENTION = 4;
export const TIER_READY = 3;
export const TIER_RUNNING = 2;
export const TIER_PINNED = 1;
export const TIER_REST = 0;

export const TIER_ORDER = [TIER_ATTENTION, TIER_READY, TIER_RUNNING, TIER_PINNED, TIER_REST];

export const TIER_LABELS: Record<number, string> = {
  [TIER_ATTENTION]: 'Needs input',
  [TIER_READY]: 'Ready',
  [TIER_RUNNING]: 'Working',
  [TIER_PINNED]: 'Pinned',
  [TIER_REST]: 'Recent',
};

/** What is currently true of one session, as far as ranking cares. */
export interface SessionSignals {
  /** The CLI asked for the user (OSC 9). */
  needsAttention: boolean;
  /** Claude finished a turn the user hasn't looked at. */
  responseReady: boolean;
  /** A CLI turn is in flight, per the OSC 0 spinner. */
  busy: boolean;
  /** A row invented before Claude wrote its transcript. */
  pending: boolean;
  /** A PTY is running under this id, as of the last poll. */
  hasLivePty: boolean;
}

/** A row as the truncation rules see it. */
export interface TruncatableRow {
  pinned?: boolean;
  remote?: boolean;
  /** Epoch ms the row is ordered by. */
  sortTime: number;
}

/** The caps one render pass applies. */
export interface TruncationCaps {
  /** How many rows have been kept so far. */
  count: number;
  visibleSessionCount: number;
  /** Epoch ms; older rows are dropped unless exempt. */
  ageCutoff: number;
  isActive: boolean;
}

/**
 * The block a session belongs in.
 *
 * A live session that isn't spinning has finished its turn, whether or not the
 * user has read it yet — both count as ready. Only a session reported as busy
 * (or one still starting up) is working. Busy state comes from the OSC 0
 * spinner, so a session idle since before this window opened reads as ready,
 * which is what it is.
 */
export function sessionTier(signals: SessionSignals): number {
  if (signals.needsAttention) return TIER_ATTENTION;
  if (signals.responseReady) return TIER_READY;
  if (signals.busy) return TIER_RUNNING;
  // A pending row counts as working only while a PTY is actually running under
  // it. Once that's gone it is a placeholder awaiting cleanup, and filing it
  // under Working both misreports it and — via rowSurvivesTruncation — makes it
  // impossible to age out of the list.
  if (signals.pending && signals.hasLivePty) return TIER_RUNNING;
  if (signals.hasLivePty) return TIER_READY;
  return TIER_REST;
}

/**
 * Whether a row escapes the sidebar's truncation.
 *
 * Live and pinned rows are never hidden, and neither is the open session;
 * everything else is capped by the visible count and the age cutoff.
 *
 * Remote sessions are exempt from both caps. Their work lives in a tmux session
 * on the remote host that keeps running whether or not Switchboard is connected,
 * and their `modified` only moves when the user opens them — there is no local
 * jsonl whose writes could keep the timestamp current. So a remote session that
 * had been working for days looked stale, aged out of the list, and read as if
 * it had been archived on its own. They are a small, deliberately added set;
 * Archive (or removing the remote) is the only thing that should drop one.
 */
export function rowSurvivesTruncation(
  item: TruncatableRow,
  tier: number,
  { count, visibleSessionCount, ageCutoff, isActive }: TruncationCaps,
): boolean {
  if (tier >= TIER_RUNNING || item.pinned || item.remote || isActive) return true;
  return count < visibleSessionCount && item.sortTime >= ageCutoff;
}

/** Pinning only decides where a row lands once it has nothing live to say. */
export function itemTier(item: TruncatableRow & { tier: number }): number {
  if (item.tier >= TIER_RUNNING) return item.tier;
  if (item.pinned) return TIER_PINNED;
  return TIER_REST;
}
