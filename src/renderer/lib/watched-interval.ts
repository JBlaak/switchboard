/**
 * Polls that only ask while somebody is looking.
 *
 * Electron's background throttling still fires minute-long timers in a
 * hidden or background window, so a GitHub poll on a plain `setInterval`
 * keeps spending the GraphQL budget while the user is in another app. A
 * watched interval skips its ticks while the window is hidden or out of
 * focus — the same rule the looping animations pause on (`motion/loops`) —
 * and, when the window is watched again after it skipped one, runs once at
 * once, so coming back shows fresh data without waiting for the next tick.
 */
import type {LoopDocument, LoopWindow} from './motion/loops';

export type WatchedDocument = Pick<LoopDocument, 'hidden' | 'hasFocus' | 'addEventListener' | 'removeEventListener'>;

/** Whether the window is on screen and in focus. */
export function isWatched(doc: Pick<LoopDocument, 'hidden' | 'hasFocus'> = document): boolean {
    return !doc.hidden && doc.hasFocus();
}

/** Run `tick` every `ms` while the window is watched. Answers the stop. */
export function setWatchedInterval(
    tick: () => void,
    ms: number,
    win: LoopWindow = window,
    doc: WatchedDocument = document,
): () => void {
    let skipped = false;
    const timer = setInterval(() => {
        if (isWatched(doc)) tick();
        else skipped = true;
    }, ms);
    const catchUp = (): void => {
        if (!skipped || !isWatched(doc)) return;
        skipped = false;
        tick();
    };
    win.addEventListener('focus', catchUp);
    doc.addEventListener('visibilitychange', catchUp);
    return () => {
        clearInterval(timer);
        win.removeEventListener('focus', catchUp);
        doc.removeEventListener('visibilitychange', catchUp);
    };
}
