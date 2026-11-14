/**
 * What an errand's row says, on the Errands shelf and wherever an errand's
 * session shows as an ordinary row (a stuck one in Blocked, any of them
 * among a filter's matches): one place, so the two never drift apart.
 */
import {shortRepository, type ErrandEntry} from '../../../domain/session/errand-shelf';
import type {LaidErrand} from '../../state/session-list-layout';

/** The row's name: the PR and what the errand is doing on it, `#431 · fixing checks`. */
export function errandRowName(errand: ErrandEntry): string {
    return `#${errand.number} · ${errand.doing}`;
}

/** Where it runs: the VM merging was handed off to, or the repository's short name on this Mac. */
export function errandPlace(errand: ErrandEntry): string {
    return errand.host ?? shortRepository(errand.repository);
}

/** The errand's pull request on GitHub. */
export function errandPullRequestUrl(errand: ErrandEntry): string {
    return `https://github.com/${errand.repository}/pull/${errand.number}`;
}

/** The shelf header's right side: how many need you, or else how many are running. */
export interface ErrandShelfSummary {
    readonly text: string;
    readonly needsYou: boolean;
}

export function errandShelfSummary(errands: readonly LaidErrand[]): ErrandShelfSummary {
    const stuck = errands.filter(({errand}) => errand.needsYou).length;
    if (stuck > 0) return {text: `${stuck} needs you`, needsYou: true};
    return {text: `${errands.length} running`, needsYou: false};
}
