/**
 * What a key does in the Quick Ask pop-up (B3), and where the pointer is: the
 * rules, from the key, the phase and the slab's rectangle alone, so they are
 * tested in node.
 *
 * The box's keys are the empty screen's (`ask-keys`). The pop-up adds Esc to
 * close it while editing, and keeps every key to itself while a result shows.
 * While the text matches a project (`searching`), Enter opens the highlighted
 * match and ↑/↓ move the highlight; ⌘Enter is still a quick session.
 */
import {askKey} from '../ui/ask/ask-keys';
import type {AskKey, AskKeyPress} from '../ui/ask/ask-keys';
import type {QuickAskPhase} from '../state/quick-ask-slice';

export type QuickAskKey = AskKey | 'dismiss' | 'undo' | 'open' | 'hitUp' | 'hitDown';

/** A key press, with ⌘ for ⌘Enter and for ⌘Z on the saved line. */
export type QuickAskKeyPress = AskKeyPress;

export function quickAskKey(phase: QuickAskPhase, press: QuickAskKeyPress, searching = false): QuickAskKey | null {
    if (press.isComposing) return null;
    switch (phase) {
        case 'editing':
            if (press.key === 'Escape') return 'dismiss';
            if (searching) {
                if (press.key === 'ArrowUp') return 'hitUp';
                if (press.key === 'ArrowDown') return 'hitDown';
                if (press.key === 'Enter' && !press.shiftKey && !press.metaKey) return 'open';
            }
            return askKey(phase, press);
        case 'waiting':
        case 'choosing':
            return askKey(phase, press);
        // A capture half-written is not cancelled from here (B4).
        case 'saving':
            return press.key === 'Escape' || press.key === 'Enter' || press.key === 'Tab' ? 'swallow' : null;
        // Nor one half taken back, and the box under it, editable again, takes no keys yet.
        case 'undoing':
            return 'swallow';
        case 'saved':
            if (press.metaKey && press.key.toLowerCase() === 'z' && !press.shiftKey) return 'undo';
            return press.key === 'Escape' ? 'dismiss' : 'swallow';
        case 'started':
        case 'undone':
            return press.key === 'Escape' ? 'dismiss' : 'swallow';
    }
}

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** Whether the pointer at (`x`, `y`) is over the slab, whose box is `rect`; both in the page's pixels. */
export function overSlab(x: number, y: number, rect: Rect): boolean {
    return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}
