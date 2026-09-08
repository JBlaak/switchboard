/**
 * How a session row is ranked, and whether it survives the sidebar's truncation.
 *
 * Split out of sidebar.ts so it can be tested without a DOM: sidebar.ts reaches
 * for `document` and morphdom when it loads, this reaches only for state.
 */
import {
  attentionSessions, pendingSessions, responseReadySessions, sessionBusyState, state,
} from './state.js';

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

// A live session that isn't spinning has finished its turn, whether or not the
// user has read it yet — both count as ready. Only a session reported as busy
// (or one still starting up) is working. Busy state comes from the OSC 0 spinner,
// so a session idle since before this window opened reads as ready, which is
// what it is.
export function sessionTier(sessionId: string): number {
  if (attentionSessions.has(sessionId)) return TIER_ATTENTION;
  if (responseReadySessions.has(sessionId)) return TIER_READY;
  if (sessionBusyState.get(sessionId)) return TIER_RUNNING;
  // A pending row counts as working only while a PTY is actually running under
  // it. Once that's gone it is a placeholder awaiting cleanup, and filing it
  // under Working both misreports it and — via rowSurvivesTruncation — makes it
  // impossible to age out of the list.
  if (pendingSessions.has(sessionId) && state.activePtyIds.has(sessionId)) return TIER_RUNNING;
  if (state.activePtyIds.has(sessionId)) return TIER_READY;
  return TIER_REST;
}

// Whether a row escapes the sidebar's truncation. Live and pinned rows are
// never hidden, and neither is the open session; everything else is capped by
// state.visibleSessionCount and the age cutoff.
//
// Remote sessions are exempt from both caps. Their work lives in a tmux session
// on the remote host that keeps running whether or not Switchboard is connected,
// and their `modified` only moves when the user opens them — there is no local
// jsonl whose writes could keep the timestamp current. So a remote session that
// had been working for days looked stale, aged out of the list, and read as if
// it had been archived on its own. They are a small, deliberately added set;
// Archive (or removing the remote) is the only thing that should drop one.
export function rowSurvivesTruncation(
  item: TruncatableRow,
  tier: number,
  { count, visibleSessionCount, ageCutoff, isActive }: TruncationCaps,
): boolean {
  if (tier >= TIER_RUNNING || item.pinned || item.remote || isActive) return true;
  return count < visibleSessionCount && item.sortTime >= ageCutoff;
}

// Pinning only decides where a row lands once it has nothing live to say.
export function itemTier(item: TruncatableRow & { tier: number }): number {
  if (item.tier >= TIER_RUNNING) return item.tier;
  if (item.pinned) return TIER_PINNED;
  return TIER_REST;
}

