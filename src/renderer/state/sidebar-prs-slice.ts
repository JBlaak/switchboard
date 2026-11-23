/**
 * The sidebar's pull request list's own state: where its keyboard cursor is,
 * and whether it is reading your open PRs right now.
 *
 * The PRs themselves are the Merge manager's (`mergeManager.state` for the
 * lanes, `mergeManager.notLanded` for the rest); this only holds what the
 * list adds on top. The cursor is a row's key (`landedKey`), so it stays on
 * its PR when the PR moves between groups, and a cursor whose PR is gone is
 * simply not drawn (the next arrow starts again from the top).
 *
 * Not stored: the cursor ends whenever the list lets go of the focus.
 */
import type {RendererEvent} from './events';

export type SidebarPrsEvent =
    {type: 'pullRequestListCursorSet'; key: string | null} | {type: 'pullRequestListReadStarted'};

export interface SidebarPrsState {
    /** The row the keyboard is on (`landedKey`); null while the list does not have the keys. */
    readonly cursor: string | null;
    /** A read of your open PRs the list asked for is in flight. */
    readonly reading: boolean;
}

export const initialSidebarPrsState: SidebarPrsState = {cursor: null, reading: false};

export function sidebarPrsReducer(state: SidebarPrsState, event: RendererEvent): SidebarPrsState {
    switch (event.type) {
        case 'pullRequestListCursorSet':
            return event.key === state.cursor ? state : {...state, cursor: event.key};
        case 'pullRequestListReadStarted':
            return state.reading ? state : {...state, reading: true};
        // Every read of the open PRs answers with this, the list's or the Merge manager's.
        case 'mergeManagerNotLandedLoaded':
            return state.reading ? {...state, reading: false} : state;
        default:
            return state;
    }
}
