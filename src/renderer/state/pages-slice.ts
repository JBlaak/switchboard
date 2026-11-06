/**
 * The pages sessions showed the user (`show_page`), one per session at most.
 *
 * A page arrives open, laid over its session's terminal. Closing it (Esc, the
 * close button) only puts it away: the terminal header offers it back until
 * the session shows another page, which replaces it, or is archived. Main
 * keeps no copy, so this is the only one.
 *
 * Keyed by the session's current id, so a page follows the session through a
 * re-key (a fork, an accepted plan) like the other per-session slices.
 */
import {movedEntry, withEntry, withoutEntry} from './records';
import type {IdRecord} from './records';
import type {RendererEvent} from './events';

export interface SessionPage {
    readonly title: string;
    readonly html: string;
    readonly shownAt: number;
    /** Laid over the terminal; false once put away. */
    readonly open: boolean;
}

export interface PagesState {
    readonly bySession: IdRecord<SessionPage>;
}

export type PagesEvent =
    /** Esc or the close button: the page steps aside for the terminal. */
    | {type: 'pageClosed'; sessionId: string}
    /** The terminal header's button: the page put away comes back. */
    | {type: 'pageReopened'; sessionId: string};

export const initialPagesState: PagesState = {bySession: {}};

export function pagesReducer(state: PagesState, event: RendererEvent): PagesState {
    switch (event.type) {
        case 'pageShown': {
            const {sessionId, title, html, shownAt} = event.page;
            return {bySession: withEntry(state.bySession, sessionId, {title, html, shownAt, open: true})};
        }
        case 'pageClosed':
            return opened(state, event.sessionId, false);
        case 'pageReopened':
            return opened(state, event.sessionId, true);
        case 'sessionArchived': {
            const bySession = withoutEntry(state.bySession, event.sessionId);
            return bySession === state.bySession ? state : {bySession};
        }
        default:
            return state;
    }
}

export function rekeyPages(state: PagesState, oldId: string, newId: string): PagesState {
    const bySession = movedEntry(state.bySession, oldId, newId);
    return bySession === state.bySession ? state : {bySession};
}

/** The session's page while it is laid over the terminal; null when it has none or it was put away. */
export function openPage(state: PagesState, sessionId: string | null): SessionPage | null {
    const page = sessionId ? state.bySession[sessionId] : undefined;
    return page?.open ? page : null;
}

function opened(state: PagesState, sessionId: string, open: boolean): PagesState {
    const page = state.bySession[sessionId];
    if (!page || page.open === open) return state;
    return {bySession: withEntry(state.bySession, sessionId, {...page, open})};
}
