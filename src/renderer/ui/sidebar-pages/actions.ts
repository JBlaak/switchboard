/**
 * Which page the sidebar shows: the session list or your pull requests.
 *
 * The switch at the top of the list, Cmd+P (here and in the terminal's key
 * handler) and a settled swipe call these; the slide itself follows the
 * store, in `install-sidebar-pages`.
 */
import {dispatch, getState} from '../../state/app-store';
import {otherPage} from './swipe';
import type {SidebarPage} from '../../state/sidebar-page-slice';

export function showSidebarPage(page: SidebarPage): void {
    dispatch({type: 'sidebarPageShown', page});
}

/** Cmd+P: the other page. */
export function flipSidebarPage(): void {
    showSidebarPage(otherPage(getState().sidebarPage.page));
}
