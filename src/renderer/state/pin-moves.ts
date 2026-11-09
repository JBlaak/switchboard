/**
 * Moving a pinned entry within its section (#379), by dragging it or with
 * ⌥↑ / ⌥↓: which entries can move, what a move sends to main, and where a
 * drag drops.
 *
 * Pinned projects, Pinned plans and Pinned each keep an order of their own.
 * An entry only moves within its section, and only in the unfiltered list:
 * a filter or a search has no sections, and hides the pinned projects and
 * plans anyway.
 *
 * Pure: the layout in, the move out; the drag's DOM and the IPC call are the
 * session list's (`ui/session-list/pin-drag`, `actions`).
 */
import {TIER_PINNED, TIER_PINNED_PLAN, TIER_PINNED_PROJECT} from '../../domain/session/tiers';
import {comparePinPositions} from '../../domain/pin/pin-order';
import type {PinRef, PinSection, PinTarget} from '../../domain/pin/pin-order';
import type {CursorTarget} from './list-cursor';
import type {LaidEntry, SessionListLayout} from './session-list-layout';

/** The section a tier's entries are ordered in, or null for one in no order of the user's. */
export function pinSectionOfTier(tier: number): PinSection | null {
    switch (tier) {
        case TIER_PINNED_PROJECT:
            return 'projects';
        case TIER_PINNED_PLAN:
            return 'plans';
        case TIER_PINNED:
            return 'sessions';
        default:
            return null;
    }
}

/**
 * The pins behind an entry in its section, in their order: a project's or
 * a plan's own pin, a pinned session's, or a group's pinned sessions'.
 */
export function entryPins({entry, tier}: LaidEntry): PinRef[] {
    switch (entry.kind) {
        case 'project':
            return [{kind: 'project', projectPath: entry.projectPath}];
        case 'plan':
            return [
                {kind: 'issuePlan', projectPath: entry.projectPath, repository: entry.repository, number: entry.number},
            ];
        case 'group':
            if (tier === TIER_PINNED_PLAN) return [{kind: 'plan', projectPath: entry.projectPath, slug: entry.slug}];
            return entry.sessions
                .filter((r) => r.session.starred)
                .sort((a, b) => comparePinPositions(a.session.pinPosition, b.session.pinPosition))
                .map((r) => ({kind: 'session', sessionId: r.session.sessionId}));
        case 'row':
            return entry.session.starred ? [{kind: 'session', sessionId: entry.session.sessionId}] : [];
    }
}

/** A pinned section as the list shows it, and where one of its entries is in it. */
export interface PinnedSection {
    readonly section: PinSection;
    readonly tier: number;
    readonly entries: readonly LaidEntry[];
    /** The entry asked about. */
    readonly index: number;
}

/**
 * The pinned section the top-level entry `entryId` is in, or null when it is
 * in none, or the list is filtered.
 */
export function pinnedSectionOf(layout: SessionListLayout | null, entryId: string): PinnedSection | null {
    if (!layout || layout.filtering) return null;
    const laid = layout.visible.find((l) => l.entry.id === entryId);
    if (!laid) return null;
    const section = pinSectionOfTier(laid.tier);
    if (!section) return null;
    const entries = layout.visible.filter((l) => l.tier === laid.tier);
    return {section, tier: laid.tier, entries, index: entries.indexOf(laid)};
}

/** What main is asked to do: put these pins next to that one. */
export interface PinMove {
    readonly moving: PinRef[];
    readonly target: PinTarget;
}

/**
 * Moving the entry at `from` so it ends up at `slot`: its index among the
 * other entries, 0 above them all, their count below them all. Null when it
 * would stay where it is, or there is nowhere else to go.
 */
export function pinMove(entries: readonly LaidEntry[], from: number, slot: number): PinMove | null {
    const others = entries.filter((_, i) => i !== from);
    if (from < 0 || from >= entries.length || others.length === 0) return null;
    if (slot === from || slot < 0 || slot > others.length) return null;
    const moving = entryPins(entries[from]);
    if (moving.length === 0) return null;
    if (slot < others.length) {
        const [first] = entryPins(others[slot]);
        return first ? {moving, target: {before: first}} : null;
    }
    const last = entryPins(others[others.length - 1]).at(-1);
    return last ? {moving, target: {after: last}} : null;
}

/** ⌥↑ / ⌥↓: one place up or down, or null at the end of the section. */
export function stepPinMove(found: PinnedSection, direction: -1 | 1): PinMove | null {
    return pinMove(found.entries, found.index, found.index + direction);
}

/**
 * The slot a drag at `y` drops into: how many of the other entries' middles
 * (in order, top to bottom) are above it.
 */
export function dropSlot(middles: readonly number[], y: number): number {
    let slot = 0;
    while (slot < middles.length && middles[slot] < y) slot++;
    return slot;
}

/**
 * How far the entry at `n` moves to make room while the one dragged from
 * `from` would drop into `slot` (counted among the others): down one stride
 * if the dragged one goes from below it to above it, up one if the other way
 * round, and not at all otherwise.
 */
export function makeRoom(n: number, from: number, slot: number, stride: number): number {
    if (n < from && n >= slot) return stride;
    if (n > from && n <= slot) return -stride;
    return 0;
}

/**
 * The top-level entry a cursor target moves with: its own, or for a row
 * inside a group, or a group's header, the group's. Null for what never
 * moves (labels, toggles).
 */
export function cursorEntryId(target: CursorTarget): string | null {
    switch (target.kind) {
        case 'row':
            return target.groupId ?? target.name;
        case 'header':
            return target.groupId;
        case 'plan':
        case 'project':
            return target.name;
        default:
            return null;
    }
}
