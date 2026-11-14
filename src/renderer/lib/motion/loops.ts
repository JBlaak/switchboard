/**
 * Holding the looping animations still while nobody is looking.
 *
 * A spinner, a shimmer or a ripple that loops for as long as a session is
 * busy or waiting keeps Chromium drawing frames at the display's full rate,
 * even while the window sits behind another app. Every rule that loops
 * forever reads its play state from `--loop-state` (see `_motion.scss`), and
 * this flips the root's `loops-paused` class, which sets it to `paused`,
 * while the window is hidden or out of focus — the same rule the Patch family
 * scene pauses on. Animations that end on their own are left alone, because
 * code waits for some of them to finish.
 */

/** The root class that pauses every looping animation. */
export const LOOPS_PAUSED_CLASS = 'loops-paused';

export interface LoopWindow {
    addEventListener(type: 'focus' | 'blur', listener: () => void): void;
    removeEventListener(type: 'focus' | 'blur', listener: () => void): void;
}

export interface LoopDocument {
    readonly hidden: boolean;
    hasFocus(): boolean;
    readonly documentElement: {classList: {toggle(token: string, force: boolean): boolean}};
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Follow the window's focus and visibility from now on. Answers a teardown. */
export function installLoopPause(win: LoopWindow = window, doc: LoopDocument = document): () => void {
    const sync = (): void => {
        doc.documentElement.classList.toggle(LOOPS_PAUSED_CLASS, doc.hidden || !doc.hasFocus());
    };
    sync();
    win.addEventListener('focus', sync);
    win.addEventListener('blur', sync);
    doc.addEventListener('visibilitychange', sync);
    return () => {
        win.removeEventListener('focus', sync);
        win.removeEventListener('blur', sync);
        doc.removeEventListener('visibilitychange', sync);
    };
}
