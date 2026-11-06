/**
 * The contract between main and the 1Password heads-up pop-up.
 *
 * A window of its own with its own preload, like Quick Ask's, so it gets its
 * own global, `window.headsUp`, and can reach nothing else.
 */
import type {Unsubscribe} from './api';
import type {HeadsUpAnswer, OnePasswordHeadsUp} from '../domain/onepassword/heads-up';

export type {HeadsUpAnswer, OnePasswordHeadsUp};

/** What the pop-up is told each time it shows a heads-up. */
export interface HeadsUpShown {
    headsUp: OnePasswordHeadsUp;
    /** The system's Reduce motion setting, read as it shows. */
    reduceMotion: boolean;
}

export interface HeadsUpApi {
    /** Enter (`go`) or Escape (`stop`) on the heads-up with this id. */
    answer(id: string, answer: HeadsUpAnswer): void;
    /** The page has loaded and listens; main re-sends what is on screen. */
    ready(): void;
    onShown(listener: (shown: HeadsUpShown) => void): Unsubscribe;
}
