/**
 * What a freshness line says, worked out without React so it can be tested.
 *
 * Every GitHub-backed view has one quiet line under its header: how old what
 * it shows is ("Updated 3m ago"), any extra reads it shows beside the main
 * one ("· plans 4m ago"), and then at most one status, in this order:
 *
 * - **held**: GitHub's GraphQL budget is low and main holds the expensive
 *   reads back ("Paused: GitHub budget low until 14:20"). A held read answers
 *   no data, as a failed one does, so the hold explains a failure or a
 *   refresh that gets nowhere better than either would.
 * - **refreshing**: a read is in flight ("Updating…", beside a spinner).
 * - **failed**: the last read failed, so what shows is older ("Couldn't refresh").
 */
import {formatDate} from '../../lib/format';

export interface FreshnessPart {
    readonly label: string;
    /** When this part was read from GitHub; null when never, and then it is left out. */
    readonly at: number | null;
}

export interface FreshnessInput {
    /** When the shown data was read from GitHub; null when never. */
    readonly fetchedAt: number | null;
    /** A read is in flight right now. */
    readonly refreshing?: boolean;
    /** The last read failed (the data shown is older). */
    readonly failed?: boolean;
    /** Extra parts after the main age, e.g. [{label: 'plans', at: 1234}] → "· plans 4m ago". */
    readonly parts?: readonly FreshnessPart[];
    /** Opt out of the held status where a view's reads are never held (lanes). Default true. */
    readonly showHeld?: boolean;
}

export type FreshnessStatusKind = 'held' | 'refreshing' | 'failed';

export interface FreshnessLine {
    /** "Updated 3m ago · plans 4m ago"; null when nothing was read yet. */
    readonly ages: string | null;
    /** The one status after the ages, or null. */
    readonly status: {readonly kind: FreshnessStatusKind; readonly text: string} | null;
}

/** Between the ages, and before the status. */
export const FRESHNESS_SEPARATOR = ' · ';

/**
 * The line for `input` at `now`, with GitHub's budget held until `heldUntil`
 * (null when it is not); null when there is nothing to say.
 */
export function freshnessLine(input: FreshnessInput, now: number, heldUntil: number | null): FreshnessLine | null {
    const ages = [
        input.fetchedAt === null ? null : 'Updated ' + ago(input.fetchedAt, now),
        ...(input.parts ?? []).map((part) => (part.at === null ? null : `${part.label} ${ago(part.at, now)}`)),
    ].filter((age): age is string => age !== null);
    const status = statusOf(input, now, heldUntil);
    if (ages.length === 0 && status === null) return null;
    return {ages: ages.length === 0 ? null : ages.join(FRESHNESS_SEPARATOR), status};
}

/** The whole line as one string, as it reads on screen; null when there is nothing to say. */
export function freshnessText(input: FreshnessInput, now: number, heldUntil: number | null): string | null {
    const line = freshnessLine(input, now, heldUntil);
    if (!line) return null;
    return [line.ages, line.status?.text ?? null].filter((text) => text !== null).join(FRESHNESS_SEPARATOR);
}

function statusOf(input: FreshnessInput, now: number, heldUntil: number | null): FreshnessLine['status'] {
    if (input.showHeld !== false && heldUntil !== null && heldUntil > now)
        return {kind: 'held', text: `Paused: GitHub budget low until ${clockTime(heldUntil)}`};
    if (input.refreshing) return {kind: 'refreshing', text: 'Updating…'};
    if (input.failed) return {kind: 'failed', text: 'Couldn’t refresh'};
    return null;
}

/** "3m ago", never in the future: a clock that ticked a moment before the read says "just now". */
function ago(at: number, now: number): string {
    return formatDate(new Date(at), Math.max(now, at));
}

/** HH:MM in local time. */
function clockTime(ms: number): string {
    const at = new Date(ms);
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
