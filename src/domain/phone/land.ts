/**
 * Land it on the phone: what a session's screen offers for its pull request,
 * and the words its toast says, by the Mac's own rules (`merge-manager/land-it`).
 *
 * The Mac's session header offers Land it for the session's newest open PR as
 * `gh` read it (#436). The phone gets the same once it asked (`land-check`);
 * before that, the session's newest PR from its transcript stands in, taken
 * as yours and open, which is how the sidebar's L treats a PR `gh` has not
 * read: main judges it when it is pressed, and says why it did not land.
 */
import {landOffer, landedPillText, landedToastText, sessionLandCandidate} from '../merge-manager/land-it';
import {findLanded} from '../merge-manager/stage-words';
import type {LandCandidate} from '../merge-manager/land-it';
import type {LandedView, MergeManagerState} from '../merge-manager/model';
import type {LinkedPr} from '../session/links';
import type {SessionPullRequest} from '../session/session';
import type {PhoneLand} from './protocol';

/** The button's words on your own open PR. */
export const LAND_IT = 'Land it';

/**
 * The PR a session offers Land it for: from what `gh` read when it has
 * (`checked`), else its transcript's newest PR with a repository.
 */
export function phoneLandCandidate(
    checked: readonly LinkedPr[] | undefined,
    transcript: readonly SessionPullRequest[],
): LandCandidate | null {
    const read = checked ? sessionLandCandidate(checked) : null;
    if (read) return read;
    const newest = [...transcript].reverse().find((pr) => pr.repository);
    return newest ? {repository: newest.repository, number: newest.number, state: 'open', mine: true} : null;
}

/** What the session's screen shows for `pr`: Land it, Land it disabled on a draft, its landed stage, or nothing. */
export function phoneLand(pr: LandCandidate | null, state: MergeManagerState): PhoneLand | null {
    if (!pr) return null;
    const offer = landOffer(pr, state);
    if (!offer) return null;
    const {repository, number} = pr;
    switch (offer.kind) {
        case 'land':
            return {repository, number, offer: 'land', label: LAND_IT};
        case 'draft':
            return {repository, number, offer: 'draft', label: offer.hint};
        case 'landed':
            return {repository, number, offer: 'landed', label: landedPillText(offer.landed, offer.lane)};
    }
}

/** The toast after a land: "Landed #432 · 2nd in switchboard's lane", as the Mac's. */
export function phoneLandedText(landed: LandedView | null, number: number, state: MergeManagerState): string {
    if (!landed) return `Landed #${number}`;
    return landedToastText(landed, findLanded(state, landed.repository, landed.number)?.lane);
}

/** The toast when a land or unland failed: "Could not land #432: it is a draft", as the Mac's. */
export function phoneLandFailedText(action: 'land' | 'unland', number: number, reason: string): string {
    return `Could not ${action}${number ? ' #' + number : ''}: ${reason}`;
}
