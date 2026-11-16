/**
 * The freshness lines' launch-time work: read until when GitHub's expensive
 * reads are held back, which main may have known since before the window
 * opened; every change after is pushed (`githubBudgetHeld`).
 */
import {dispatch} from '../../state/app-store';

export function installGithubBudget(): void {
    void window.api
        .githubHeldUntil()
        .then((until) => dispatch({type: 'githubBudgetHeld', until}))
        .catch(() => {
            // Main says so on its next change.
        });
}
