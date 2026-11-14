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

/**
 * Whether a push changed what the session list shows of errands: which
 * sessions are errands, or anything one of them says on the shelf. Main
 * pushes the Merge manager's lanes on every change of any PR, most of which
 * leave the errands as they were, and laying the list out again for those
 * would only churn it.
 */
export function errandsChanged(previous: RendererState, state: RendererState): boolean {
    if (
        previous.mergeManager.state === state.mergeManager.state &&
        previous.mergeQueue.errands === state.mergeQueue.errands
    )
        return false;
    const before = errandsBySession(previous.mergeManager.state, previous.mergeQueue.errands);
    const after = errandIndex(state);
    if (before.size !== after.size) return true;
    for (const [sessionId, errand] of after) {
        const was = before.get(sessionId);
        if (!was) return true;
        for (const field of Object.keys(errand) as (keyof ErrandEntry)[]) {
            if (was[field] !== errand[field]) return true;
        }
    }
    return false;
}
