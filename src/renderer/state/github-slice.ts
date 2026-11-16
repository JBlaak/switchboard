/**
 * GitHub's GraphQL budget as main last said (`githubBudgetHeld`): until when
 * its expensive reads are held back, which every freshness line shows as
 * "Paused: GitHub budget low until 14:20". Null when they are not held.
 *
 * The time is kept as main sent it, past or not; the lines compare it with
 * the ticking clock, and main sends null once it lifts.
 */
import type {RendererEvent} from './events';

export interface GithubState {
    /** Epoch milliseconds, or null when nothing is held back. */
    readonly heldUntil: number | null;
}

export const initialGithubState: GithubState = {heldUntil: null};

export function githubReducer(state: GithubState, event: RendererEvent): GithubState {
    switch (event.type) {
        case 'githubBudgetHeld':
            return event.until === state.heldUntil ? state : {...state, heldUntil: event.until};
        default:
            return state;
    }
}
