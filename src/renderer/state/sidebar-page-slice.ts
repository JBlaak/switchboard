/**
 * Which page the sidebar shows: the session list, or your open pull requests.
 *
 * A two-finger swipe across the sidebar, the switch at its top, or Cmd+P
 * flips between the two. The swipe itself (how far the fingers have gone)
 * is not kept here: it is a gesture in flight, drawn straight from the
 * wheel events, and only the page it settles on is state.
 *
 * Not stored: the app always starts on Sessions.
 */
import type {RendererEvent} from './events';

export type SidebarPage = 'sessions' | 'pullRequests';

export type SidebarPageEvent = {type: 'sidebarPageShown'; page: SidebarPage};

export interface SidebarPageState {
    readonly page: SidebarPage;
}

export const initialSidebarPageState: SidebarPageState = {page: 'sessions'};

export function sidebarPageReducer(state: SidebarPageState, event: RendererEvent): SidebarPageState {
    if (event.type !== 'sidebarPageShown' || event.page === state.page) return state;
    return {page: event.page};
}
