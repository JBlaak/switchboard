/**
 * Loading a file's OmniDiff refinement from main.
 *
 * Like the image card's bytes, refinements live outside the store: a small
 * registry of main's answers, keyed by the item's diff as it was asked for
 * (`loadKey`), the item and the path. Each is asked once; an answer (null
 * included, and any error as null) is kept until the item's diff is asked for
 * again under another key, when the old answers go. Components subscribe to
 * it and redraw when their file's answer lands.
 */
import {useEffect, useSyncExternalStore} from 'react';
import type {FileDiff} from '../../../domain/session-work/model';
import type {FileRefinement} from '../../../domain/session-work/refinement';

export interface RefinementRequest {
    readonly sessionId: string;
    readonly itemId: string;
    readonly path: string;
}

type Fetch = (request: RefinementRequest) => Promise<FileRefinement | null>;

const defaultFetch: Fetch = (request) => window.api.sessionWorkRefinement({...request});

/** key → main's answer; `undefined` while it is asked. */
const answers = new Map<string, FileRefinement | null | undefined>();
/** `sessionId` + `itemId` → the `loadKey` its answers are for. */
const current = new Map<string, string>();
const listeners = new Set<() => void>();

/**
 * Whether a file can have a refinement worth asking for: a text file changed
 * in place or renamed, with lines, drawn as lines (not an image card). Main
 * reads its sides from the checkout or, for GitHub's copy of a diff, from GitHub.
 */
export function refinable(file: FileDiff, imageCard: boolean): boolean {
    return (
        (file.status === 'modified' || file.status === 'renamed') && !file.binary && !imageCard && file.hunks.length > 0
    );
}

export function refinementKey(request: RefinementRequest, loadKey: string): string {
    return [request.sessionId, request.itemId, loadKey, request.path].join('\0');
}

/** The answer for this file so far: null until it lands, and when there is none. */
export function peekRefinement(request: RefinementRequest, loadKey: string): FileRefinement | null {
    return answers.get(refinementKey(request, loadKey)) ?? null;
}

/**
 * Ask main for this file's refinement, unless it was asked under this
 * `loadKey` already. A new `loadKey` for the item drops its older answers.
 */
export function requestRefinement(request: RefinementRequest, loadKey: string, fetch: Fetch = defaultFetch): void {
    const item = request.sessionId + '\0' + request.itemId;
    const was = current.get(item);
    if (was !== loadKey) {
        if (was !== undefined) {
            const stale = request.sessionId + '\0' + request.itemId + '\0' + was + '\0';
            for (const key of [...answers.keys()]) if (key.startsWith(stale)) answers.delete(key);
        }
        current.set(item, loadKey);
    }
    const key = refinementKey(request, loadKey);
    if (answers.has(key)) return;
    answers.set(key, undefined);

    const settle = (answer: FileRefinement | null): void => {
        // Dropped meanwhile: the item's diff was asked for again.
        if (!answers.has(key)) return;
        answers.set(key, answer);
        for (const listener of [...listeners]) listener();
    };
    let pending: Promise<FileRefinement | null>;
    try {
        pending = fetch(request);
    } catch {
        pending = Promise.resolve(null);
    }
    pending.then(
        (answer) => settle(answer ?? null),
        () => settle(null),
    );
}

/** Be told when an answer lands. Answers the unsubscribe. */
export function subscribeRefinements(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Forget every answer; for tests. */
export function resetRefinements(): void {
    answers.clear();
    current.clear();
}

/**
 * `file`'s refinement once `enabled` and main has answered; null before, when
 * there is none, and whenever it is not enabled. Only text files that are
 * drawn as lines should be enabled (see `refinable`), so a
 * collapsed file asks only once it is opened.
 */
export function useRefinement(
    sessionId: string,
    itemId: string,
    file: FileDiff,
    loadKey: string,
    enabled: boolean,
): FileRefinement | null {
    const {path} = file;
    const refinement = useSyncExternalStore(subscribeRefinements, () =>
        enabled ? peekRefinement({sessionId, itemId, path}, loadKey) : null,
    );
    useEffect(() => {
        if (enabled) requestRefinement({sessionId, itemId, path}, loadKey);
    }, [sessionId, itemId, path, loadKey, enabled]);
    return refinement;
}
