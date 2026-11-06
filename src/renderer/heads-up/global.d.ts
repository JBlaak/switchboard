/**
 * `window.headsUp`, set by the 1Password heads-up pop-up's own preload. Only
 * the pop-up's bundle reads it.
 */
import type {HeadsUpApi} from '../../ipc/heads-up-api';

declare global {
    interface Window {
        headsUp: HeadsUpApi;
        switchboardE2E?: true;
    }
}

export {};
