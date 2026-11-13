/**
 * Seen again after the merge (#414, for #409): a fixed bug that gets events
 * after its Fix PR merged is either back (regressed) or still coming from a
 * release that never had the fix.
 *
 * Switchboard does not follow releases. It compares each event's app version
 * with the first tag that contains the merge commit (`v4.12.1` ≈ `4.12.1`);
 * when either has no version to compare, the event's time is compared with
 * the tag's date instead. An event from that release or a newer one means
 * the fix did not hold: regressed. Events only from older releases ask you
 * instead ("seen again"). A project without release tags, or a merge that no
 * tag contains yet, cannot tell, so it always asks.
 */
import type {BugsnagEvent} from '../bugsnag/model';
import type {SeenAgainNotice} from './model';

/** The first tag that contains a merge commit. */
export interface FixTag {
    readonly name: string;
    /** ISO: when the tag (or its commit) was made. */
    readonly at: string;
}

/** What the events after a merge say: back (regressed), or a notice that asks you. */
export type SeenAgainVerdict = {readonly kind: 'regressed'} | ({readonly kind: 'notice'} & SeenAgainNotice);

/** The numbers of a version or tag (`v4.12.1`, `4.12.1 (3121)`, `release-4.12`); null for none. */
export function versionNumbers(version: string): number[] | null {
    const match = version.match(/(\d+(?:\.\d+)*)/);
    return match ? match[1]!.split('.').map(Number) : null;
}

/** Negative when `a` is the older version, 0 when they are the same, positive when newer; missing parts are 0. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** Whether an event comes from the release with the fix or a newer one. */
export function fromFixedRelease(event: BugsnagEvent, tag: FixTag): boolean {
    const eventVersion = event.appVersion ? versionNumbers(event.appVersion) : null;
    const tagVersion = versionNumbers(tag.name);
    if (eventVersion && tagVersion) return compareVersions(eventVersion, tagVersion) >= 0;
    const received = Date.parse(event.receivedAt);
    const tagged = Date.parse(tag.at);
    // Without a time either, it cannot be told apart: ask rather than reopen.
    return Number.isFinite(received) && Number.isFinite(tagged) && received >= tagged;
}

/**
 * The verdict on the events received after a merge, newest first; null when
 * there are none. `tag` is the first tag containing the merge, null when no
 * tag has it; `tagged` whether the project tags its releases at all.
 */
export function judgeSeenAgain(
    events: readonly BugsnagEvent[],
    tag: FixTag | null,
    tagged: boolean,
): SeenAgainVerdict | null {
    if (events.length === 0) return null;
    if (tagged && tag && events.some((event) => fromFixedRelease(event, tag))) return {kind: 'regressed'};
    const newest = [...events].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0]!;
    return {
        kind: 'notice',
        events: events.length,
        version: newest.appVersion,
        tag: tagged ? (tag?.name ?? null) : null,
        tagged,
    };
}

/** The line the Done row shows for a notice. */
export function seenAgainLine(notice: SeenAgainNotice): string {
    const these = notice.events === 1 ? 'this event comes' : `these ${notice.events} events come`;
    const from = notice.version ?? 'a version it did not report';
    if (!notice.tagged) {
        return `Seen again after the merge: ${these} from ${from}, and this project does not tag its releases, so whether it has the fix can't be told. Close it again?`;
    }
    if (!notice.tag) {
        return `Seen again after the merge, but ${these} from ${from}, and no release has the fix yet. Close it again?`;
    }
    return `Seen again after the merge, but ${these} from ${from}, a release without the fix (first in ${notice.tag}). Close it again?`;
}
