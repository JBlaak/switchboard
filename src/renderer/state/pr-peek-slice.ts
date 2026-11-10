/**
 * The pull request peek: a quick look at a PR's diff, over whatever is on
 * screen, that every PR link in the app opens instead of the browser (see
 * `ui/pr-view`). From there Full view goes on to the work page and Open on
 * GitHub to the browser.
 *
 * One peek at a time. Each open carries an id the action picked, and the
 * answer comes back with it: an answer for a peek that was closed, or that
 * another PR's peek replaced while `gh` was still busy, finds a different id
 * (or none) and is dropped, so a slow PR can never paint over a newer one.
 *
 * The events are declared here rather than in `events.ts`, like the archive
 * Undo's, so the vocabulary stays in one file.
 */
import type {RendererEvent} from './events';
import type {DiffMode} from './session-work-slice';
import type {FileDiff, PullRequestStatus} from '../../domain/session-work/model';
import type {PullRequestPeek, PullRequestRef} from '../../domain/session-work/pull-request-link';

export type PrPeekEvent =
    /** A PR link was followed: its peek opens, loading. `url` is the link as it was, for Open on GitHub. */
    | {type: 'prPeekOpened'; id: number; ref: PullRequestRef; url: string}
    /** What `gh` said about the PR the peek `id` asked for. */
    | {type: 'prPeekAnswered'; id: number; peek: PullRequestPeek}
    /** The ask itself failed (the IPC threw), for the peek `id`. */
    | {type: 'prPeekFailed'; id: number; error: string}
    /** Esc, a click beside it, Close, or Full view taking over. */
    | {type: 'prPeekClosed'}
    /** Show diff on a file that starts collapsed (lock file, generated, large). */
    | {type: 'prPeekFileExpanded'; id: number; path: string}
    /** Unified or Split; the choice outlives the peek, so the next one opens the same way. */
    | {type: 'prPeekModeSet'; mode: DiffMode};

export interface PrPeek {
    readonly id: number;
    readonly ref: PullRequestRef;
    /** The link as it was followed: `/checks` and comment anchors included. */
    readonly url: string;
    readonly phase: 'loading' | 'loaded';
    /** What `gh` said about the PR; null while loading or when it said nothing. */
    readonly pr: PullRequestStatus | null;
    readonly files: readonly FileDiff[];
    /** Why there is no diff, when there is none. */
    readonly error: string | null;
    /** The collapsed files opened with Show diff. */
    readonly expanded: readonly string[];
}

export interface PrPeekState {
    readonly peek: PrPeek | null;
    readonly mode: DiffMode;
}

export const initialPrPeekState: PrPeekState = {peek: null, mode: 'unified'};

export function prPeekReducer(state: PrPeekState, event: RendererEvent): PrPeekState {
    switch (event.type) {
        case 'prPeekOpened':
            return {
                ...state,
                peek: {
                    id: event.id,
                    ref: event.ref,
                    url: event.url,
                    phase: 'loading',
                    pr: null,
                    files: [],
                    error: null,
                    expanded: [],
                },
            };
        case 'prPeekAnswered': {
            const peek = current(state, event.id);
            if (!peek) return state;
            return {
                ...state,
                peek: {
                    ...peek,
                    phase: 'loaded',
                    pr: event.peek.pr,
                    files: event.peek.files,
                    error: event.peek.error ?? null,
                },
            };
        }
        case 'prPeekFailed': {
            const peek = current(state, event.id);
            if (!peek) return state;
            return {...state, peek: {...peek, phase: 'loaded', error: event.error}};
        }
        case 'prPeekClosed':
            return state.peek ? {...state, peek: null} : state;
        case 'prPeekFileExpanded': {
            const peek = current(state, event.id);
            if (!peek || peek.expanded.includes(event.path)) return state;
            return {...state, peek: {...peek, expanded: [...peek.expanded, event.path]}};
        }
        case 'prPeekModeSet':
            return state.mode === event.mode ? state : {...state, mode: event.mode};
        default:
            return state;
    }
}

/** The open peek when it is the one `id` names; null for a stale answer. */
function current(state: PrPeekState, id: number): PrPeek | null {
    return state.peek?.id === id ? state.peek : null;
}
