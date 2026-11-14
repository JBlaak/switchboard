/**
 * Where the keyboard can go in the session list, read from the layout rather
 * than from the DOM.
 *
 * The list renders, top to bottom: each visible entry (a row, a pinned
 * project, a pinned GitHub plan, or a slug group's header followed by its rows), then the "+ N older" toggle and the
 * entries behind it, then the Errands shelf docked under the list. `cursorTargets` walks that same order and says, for each
 * thing a click would act on, whether it is on screen. The keyboard cursor
 * only lands on what is on screen; session navigation (Cmd+Shift+[ / ])
 * walks the rows in the same order, hidden ones included, as it always did.
 *
 * What is hidden is the stylesheet's rule, restated here: a folded section
 * (Pinned projects, Pinned plans) hides its entries, a folded group
 * hides its rows, the "+ N older" list hides its entries until opened, a
 * group's own "+ N more" never shows (an open group shows its rows instead,
 * and a folded one hides the container the toggle sits in), a folded Errands
 * shelf hides its rows except the ones that need you, which peek out, and
 * anything sliding out is skipped.
 *
 * The shelf has no key of its own: ↓ past the list's last target walks into
 * it, folded or not, and unfolds it (see `stepCursor`).
 *
 * Nothing here reads the DOM or the store, so it is tested in node.
 */
import {isFoldableTier} from '../../domain/session/tiers';
import type {SessionListState} from './session-list-slice';
import type {LaidEntry, SessionListRow} from './session-list-layout';

export type CursorTarget =
    | {
          readonly kind: 'row';
          readonly name: string;
          readonly shown: boolean;
          readonly sessionId: string;
          readonly groupId?: string;
      }
    | {
          readonly kind: 'plan';
          readonly name: string;
          readonly shown: boolean;
          readonly projectPath: string;
          readonly repository: string;
          readonly number: number;
      }
    | {readonly kind: 'project'; readonly name: string; readonly shown: boolean; readonly projectPath: string}
    | {readonly kind: 'header'; readonly name: string; readonly shown: boolean; readonly groupId: string}
    | {readonly kind: 'more'; readonly name: string; readonly shown: boolean; readonly groupId: string}
    | {readonly kind: 'older'; readonly name: string; readonly shown: boolean}
    | {
          readonly kind: 'errand';
          readonly name: string;
          readonly shown: boolean;
          readonly sessionId: string;
          /** Hidden only because the shelf is folded: walking onto it unfolds the shelf. */
          readonly folded: boolean;
      }
    | {readonly kind: 'section'; readonly name: string; readonly shown: boolean; readonly tier: number};

/** The cursor's name for a slug group's header, which has no element id of its own. */
export function headerTarget(groupId: string): string {
    return 'header:' + groupId;
}

/** The "+ N more" toggle inside a group, by its element id. */
export function moreTarget(groupId: string): string {
    return 'sgm-' + groupId;
}

/** A section's label, by its element id. */
export function sectionTarget(tier: number): string {
    return 'section-' + tier;
}

/**
 * Whether the section of this tier is folded away right now. A filtered list
 * draws no labels, so nothing in it is folded.
 */
export function isSectionFolded(list: SessionListState, tier: number): boolean {
    return !!list.layout && !list.layout.filtering && list.foldedSections.includes(tier);
}

/** The "+ N older" toggle, by its element id. */
export const OLDER_TARGET = 'older-all';

/**
 * Everything the list renders that a click acts on, in render order.
 *
 * `running` is the sessions with a live PTY: a group renders its running
 * rows first, so they decide the order inside it.
 */
export function cursorTargets(list: SessionListState, running: ReadonlySet<string>): CursorTarget[] {
    const {layout} = list;
    if (!layout) return [];
    const targets: CursorTarget[] = [];

    const entry = ({entry}: LaidEntry, shown: boolean): void => {
        if (entry.kind === 'row') {
            targets.push(rowTarget(entry, shown && !list.leaving[entry.id]));
            return;
        }
        if (entry.kind === 'plan') {
            const {id, projectPath, repository, number} = entry;
            targets.push({kind: 'plan', name: id, shown, projectPath, repository, number});
            return;
        }
        if (entry.kind === 'project') {
            targets.push({kind: 'project', name: entry.id, shown, projectPath: entry.projectPath});
            return;
        }
        const groupId = entry.id;
        const groupShown = shown && !list.leaving[groupId];
        targets.push({kind: 'header', name: headerTarget(groupId), shown: groupShown, groupId});

        const rowsShown = groupShown && !!list.expandedSlugs[groupId];
        const member = (row: SessionListRow): void => {
            targets.push(rowTarget(row, rowsShown && !list.leaving[row.id], groupId));
        };
        const promoted = entry.sessions.filter((r) => running.has(r.session.sessionId));
        if (promoted.length === 0) {
            entry.sessions.forEach(member);
            return;
        }
        const rest = entry.sessions.filter((r) => !running.has(r.session.sessionId));
        promoted.forEach(member);
        if (rest.length > 0) {
            targets.push({kind: 'more', name: moreTarget(groupId), shown: false, groupId});
            rest.forEach(member);
        }
    };

    // A foldable section's label is a stop of its own, and folding it hides what is under it.
    let lastTier: number | null = null;
    for (const laid of layout.visible) {
        if (!layout.filtering && laid.tier !== lastTier && isFoldableTier(laid.tier)) {
            targets.push({kind: 'section', name: sectionTarget(laid.tier), shown: true, tier: laid.tier});
        }
        lastTier = laid.tier;
        entry(laid, !isSectionFolded(list, laid.tier));
    }
    if (layout.older.length > 0) {
        targets.push({kind: 'older', name: OLDER_TARGET, shown: true});
        for (const laid of layout.older) entry(laid, list.olderExpanded);
    }
    for (const {entry: row, errand} of layout.errands) {
        const leaving = !!list.leaving[row.id];
        const peeks = list.errandShelfOpen || errand.needsYou;
        targets.push({
            kind: 'errand',
            name: row.id,
            shown: peeks && !leaving,
            sessionId: row.session.sessionId,
            folded: !peeks && !leaving,
        });
    }
    return targets;
}

function rowTarget(row: SessionListRow, shown: boolean, groupId?: string): CursorTarget {
    return {kind: 'row', name: row.id, shown, sessionId: row.session.sessionId, groupId};
}

/** The names the cursor can land on, in order. */
export function shownTargets(targets: readonly CursorTarget[]): string[] {
    return targets.filter((t) => t.shown).map((t) => t.name);
}

/** The cursor, if it names something the list still renders; a cursor on a row that has gone is no cursor. */
export function liveCursor(list: SessionListState, targets: readonly CursorTarget[]): CursorTarget | null {
    return list.cursor === null ? null : (targets.find((t) => t.name === list.cursor) ?? null);
}

/**
 * Where Cmd+L puts the cursor: where it already is, else on the open
 * session's row, else on the first thing on screen.
 */
export function startTarget(
    list: SessionListState,
    targets: readonly CursorTarget[],
    activeSessionId: string | null,
): string | null {
    const active = activeSessionId
        ? targets.find((t) => (t.kind === 'row' || t.kind === 'errand') && t.sessionId === activeSessionId)
        : undefined;
    return liveCursor(list, targets)?.name ?? active?.name ?? shownTargets(targets)[0] ?? null;
}

/**
 * One step up or down, stopping at either end. From a cursor that is not on
 * anything on screen, the first step lands on the top.
 */
export function stepTarget(shown: readonly string[], cursor: string | null, direction: -1 | 1): string | null {
    if (shown.length === 0) return null;
    const at = cursor === null ? -1 : shown.indexOf(cursor);
    if (at === -1) return shown[0];
    return shown[Math.min(shown.length - 1, Math.max(0, at + direction))];
}

/**
 * One step of the keyboard cursor, as ↑ and ↓ take it: `stepTarget` over what
 * is on screen, with a folded Errands shelf walked as if it were open, so ↓
 * past the list's last target lands on its first row even when none of them
 * peeks out. Whoever moves the cursor onto a shelf row unfolds the shelf
 * (`opensShelf`); ↑ from its first row is simply the list's last target.
 */
export function stepCursor(targets: readonly CursorTarget[], cursor: string | null, direction: -1 | 1): string | null {
    const walk = targets.filter((t) => t.shown || (t.kind === 'errand' && t.folded)).map((t) => t.name);
    return stepTarget(walk, cursor, direction);
}

/** Whether putting the cursor on `target` has to unfold the Errands shelf first. */
export function opensShelf(list: SessionListState, targets: readonly CursorTarget[], target: string): boolean {
    return !list.errandShelfOpen && targets.some((t) => t.kind === 'errand' && t.name === target);
}

/**
 * Where the cursor goes once `removed` has dropped out of the list: the next
 * thing below it that is still there, else the nearest one above, else
 * nowhere. `before` and `after` are the shown targets either side of the
 * removal.
 */
export function targetAfterRemoval(
    before: readonly string[],
    removed: string,
    after: readonly string[],
): string | null {
    const remaining = new Set(after);
    const at = before.indexOf(removed);
    return (
        before.slice(at + 1).find((name) => remaining.has(name)) ??
        before
            .slice(0, Math.max(at, 0))
            .reverse()
            .find((name) => remaining.has(name)) ??
        null
    );
}

/**
 * The session ids of the rendered rows, in render order, hidden ones and the
 * Errands shelf's included. A stuck errand is listed in Blocked and on the
 * shelf; it takes its place in Blocked only.
 */
export function rowOrder(targets: readonly CursorTarget[]): string[] {
    const ids: string[] = [];
    for (const target of targets) {
        if (target.kind !== 'row' && target.kind !== 'errand') continue;
        if (!ids.includes(target.sessionId)) ids.push(target.sessionId);
    }
    return ids;
}

/**
 * The session Cmd+Shift+[ / ] moves to: the next open one in `order` (the
 * sidebar's row order), wrapping round, skipping any `isOpen` says has ended.
 * With no open session on screen it goes to the first open one.
 */
export function stepOpenSession(
    order: readonly string[],
    isOpen: (sessionId: string) => boolean,
    current: string | null,
    direction: -1 | 1,
): string | null {
    const ids = order.filter(isOpen);
    if (ids.length === 0) return null;
    const at = current ? ids.indexOf(current) : -1;
    if (at === -1) return ids[0];
    return ids[(at + direction + ids.length) % ids.length];
}
