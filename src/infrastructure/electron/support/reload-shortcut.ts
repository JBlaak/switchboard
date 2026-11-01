/**
 * Chromium's reload shortcuts, which in this app would throw away every
 * terminal on screen.
 */
import type {Input} from 'electron';

/**
 * Whether a key press is Cmd+R or Ctrl+Shift+R.
 *
 * Plain Ctrl+R is not one: macOS does not reload on it, and in a terminal it is
 * the shell's reverse history search, which has to reach the session.
 */
export function isReloadShortcut(input: Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'shift'>): boolean {
    if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'r') return false;
    return input.meta || (input.control && input.shift);
}
