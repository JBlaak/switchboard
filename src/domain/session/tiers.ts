/**
 * How a session row is ranked, and whether it survives the sidebar's truncation.
 *
 * Pure on purpose: the caller reads the live signals out of whatever store it
 * keeps them in and hands them over, so these rules can be tested without a DOM
 * or a renderer state module.
 */
import {statusTone} from './status-tone';
import type {ToneSignals} from './status-tone';

// Sort tiers, highest first. Pinned plans come first of all: the user put them
// on top to keep them there, so they hold their place whatever their sessions
// are doing. Then the active block, split by the session's status tone (see
// `status-tone`): first the blocked ones, then the ones whose turn it is for
// the user, then the ones still working, then the merging ones, which need
// nobody and keep out of the way. Those four always outrank pinned and plain
// recent rows regardless of age.
export const TIER_PINNED_PLAN = 6;
export const TIER_ATTENTION = 5;
export const TIER_READY = 4;
export const TIER_RUNNING = 3;
export const TIER_MERGING = 2;
export const TIER_PINNED = 1;
export const TIER_REST = 0;

export const TIER_ORDER = [
    TIER_PINNED_PLAN,
    TIER_ATTENTION,
    TIER_READY,
    TIER_RUNNING,
    TIER_MERGING,
    TIER_PINNED,
    TIER_REST,
];

export const TIER_LABELS: Record<number, string> = {
    [TIER_PINNED_PLAN]: 'Pinned plans',
    [TIER_ATTENTION]: 'Blocked',
    [TIER_READY]: 'Your turn',
    [TIER_RUNNING]: 'Working',
    [TIER_MERGING]: 'Merging',
    [TIER_PINNED]: 'Pinned',
    [TIER_REST]: 'Recent',
};

/** What is currently true of one session, as far as ranking cares. */
export type SessionSignals = ToneSignals;

/** A row as the truncation rules see it. */
export interface TruncatableRow {
    pinned?: boolean;
    /** A plan (a slug group) the user pinned to the top of the list. */
    pinnedPlan?: boolean;
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

/** The block a session belongs in: its status tone's. */
export function sessionTier(signals: SessionSignals): number {
    switch (statusTone(signals)) {
        case 'blocked':
            return TIER_ATTENTION;
        case 'your-turn':
            return TIER_READY;
        case 'working':
            return TIER_RUNNING;
        case 'merging':
            return TIER_MERGING;
        case null:
            return TIER_REST;
    }
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
    {count, visibleSessionCount, ageCutoff, isActive}: TruncationCaps,
): boolean {
    if (tier >= TIER_MERGING || item.pinned || item.pinnedPlan || item.remote || isActive) return true;
    return count < visibleSessionCount && item.sortTime >= ageCutoff;
}

/**
 * A pinned plan stays on top whatever its sessions are doing; pinning a
 * session only decides where its row lands once it has nothing live to say.
 */
export function itemTier(item: TruncatableRow & {tier: number}): number {
    if (item.pinnedPlan) return TIER_PINNED_PLAN;
    if (item.tier >= TIER_MERGING) return item.tier;
    if (item.pinned) return TIER_PINNED;
    return TIER_REST;
}
