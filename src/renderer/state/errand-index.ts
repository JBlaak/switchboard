/**
 * The errand index (see `domain/session/errand-shelf`) for the renderer:
 * built from what main last pushed of the Merge manager and the merge
 * queue's errands, and rebuilt only when either changes.
 */
import {errandsBySession, type ErrandEntry} from '../../domain/session/errand-shelf';
import type {RendererState} from './root';

let lastMerge: RendererState['mergeManager']['state'] | null = null;
let lastQueue: RendererState['mergeQueue']['errands'] | null = null;
let lastIndex: ReadonlyMap<string, ErrandEntry> = new Map();

/** Every errand's session, keyed by session id. The same map until main pushes a change. */
export function errandIndex(state: RendererState): ReadonlyMap<string, ErrandEntry> {
    const merge = state.mergeManager.state;
    const queue = state.mergeQueue.errands;
    if (merge !== lastMerge || queue !== lastQueue) {
        lastMerge = merge;
        lastQueue = queue;
        lastIndex = errandsBySession(merge, queue);
    }
    return lastIndex;
}

/** The errand a session runs, or null for a session the user started. */
export function errandOf(state: RendererState, sessionId: string): ErrandEntry | null {
    return errandIndex(state).get(sessionId) ?? null;
}
