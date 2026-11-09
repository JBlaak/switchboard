/**
 * The order of what the user pinned (#379): pinned sessions, pinned projects
 * and pinned plans each keep an order of their own, the one the user dragged
 * them into.
 *
 * Every pin has a position within its section; a lower one is higher in the
 * list. A new pin goes to the end of its section, and unpinning drops the
 * position. A pin with no position yet (one stored before positions existed)
 * comes after every positioned one, newest first, which is the order the
 * section showed before it could be dragged: so a section that has never
 * been reordered keeps looking as it did.
 *
 * A section is one list across every project: Pinned plans holds the slug
 * plans and the GitHub plans of all projects together, so they share one
 * order.
 *
 * Pure: the repository reads the rows and writes the positions, the renderer
 * sorts by them; the rules are here.
 */

/** The three sections a pin can be dragged within. */
export type PinSection = 'sessions' | 'projects' | 'plans';

/** One pin, by what it is a pin on. */
export type PinRef =
    | {readonly kind: 'session'; readonly sessionId: string}
    | {readonly kind: 'project'; readonly projectPath: string}
    /** A plan by its slug: the sessions sharing it in one project. */
    | {readonly kind: 'plan'; readonly projectPath: string; readonly slug: string}
    /** A GitHub plan pinned from its page in one project. */
    | {readonly kind: 'issuePlan'; readonly projectPath: string; readonly repository: string; readonly number: number};

/** Where a moved block lands: just above one pin, or just below one. */
export type PinTarget<T = PinRef> = {readonly before: T} | {readonly after: T};

/** The section a pin is ordered in. */
export function pinSection(ref: PinRef): PinSection {
    switch (ref.kind) {
        case 'session':
            return 'sessions';
        case 'project':
            return 'projects';
        case 'plan':
        case 'issuePlan':
            return 'plans';
    }
}

/** A string that names one pin, for comparing and looking up. */
export function pinKey(ref: PinRef): string {
    switch (ref.kind) {
        case 'session':
            return 'session\0' + ref.sessionId;
        case 'project':
            return 'project\0' + ref.projectPath;
        case 'plan':
            return 'plan\0' + ref.projectPath + '\0' + ref.slug;
        case 'issuePlan':
            return 'issuePlan\0' + ref.projectPath + '\0' + ref.repository + '\0' + ref.number;
    }
}

/**
 * Lower positions first; a missing one after every position. Zero when both
 * are missing, so the caller can break the tie.
 */
export function comparePinPositions(a: number | null | undefined, b: number | null | undefined): number {
    const aMissing = a === null || a === undefined;
    const bMissing = b === null || b === undefined;
    if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    return a - b;
}

/**
 * A section's pins in order: by position, and the ones without one after
 * them, newest first (`time`, epoch ms; 0 when unknown).
 */
export function orderPins<T>(
    pins: readonly T[],
    position: (pin: T) => number | null | undefined,
    time: (pin: T) => number,
): T[] {
    return [...pins].sort((a, b) => comparePinPositions(position(a), position(b)) || time(b) - time(a));
}

/** The section's order with a new pin in it: at the end. One already there moves to the end. */
export function appendPin<T>(order: readonly T[], pin: T, key: (pin: T) => string): T[] {
    return [...withoutPin(order, pin, key), pin];
}

/** The section's order with one pin taken out, as unpinning does: the rest keep their places. */
export function withoutPin<T>(order: readonly T[], pin: T, key: (pin: T) => string): T[] {
    const gone = key(pin);
    return order.filter((p) => key(p) !== gone);
}

/**
 * Move a block of pins (one pin, or the pins of a group) next to another one,
 * keeping the block's own order and everyone else's.
 *
 * Pins in `moving` that are not in `order` are ignored. A target that is not
 * in `order`, or is itself being moved, leaves the order as it was: that is a
 * move made against a list that has changed since, and guessing would put the
 * block somewhere the user never pointed.
 */
export function moveBlock<T>(
    order: readonly T[],
    moving: readonly T[],
    target: PinTarget<T>,
    key: (pin: T) => string,
): T[] {
    const movingKeys = new Set(moving.map(key));
    const block = order.filter((p) => movingKeys.has(key(p)));
    if (block.length === 0) return [...order];
    const anchor = key('before' in target ? target.before : target.after);
    if (movingKeys.has(anchor)) return [...order];
    const rest = order.filter((p) => !movingKeys.has(key(p)));
    const at = rest.findIndex((p) => key(p) === anchor);
    if (at === -1) return [...order];
    const index = 'before' in target ? at : at + 1;
    return [...rest.slice(0, index), ...block, ...rest.slice(index)];
}
