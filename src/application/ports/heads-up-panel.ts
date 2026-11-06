/**
 * The 1Password heads-up pop-up: a window of its own, Spotlight-like, that
 * comes up over whatever app the user is in. Behind an interface so the queue
 * that decides what it shows can be tested without Electron.
 */
import type {OnePasswordHeadsUp} from '../../domain/onepassword/heads-up';

export interface HeadsUpPanel {
    /** Bring the pop-up up with this heads-up, replacing whatever it showed. */
    show(headsUp: OnePasswordHeadsUp): void;
    hide(): void;
}
