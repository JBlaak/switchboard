// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow, and a sideways swipe on the pane) ---
import {getState} from '../../state/app-store';
import {cursorTargets, neighbourOpenSession, rowOrder, stepOpenSession} from '../../state/list-cursor';
import {openSessions, sessionMap} from '../../state/session-store';
import {sessionNavDirection} from '../../lib/shortcut-keys';
import {headerNameFor} from '../sessions/terminal-header';
import {showSession} from '../terminal/terminal-manager';

export {isSessionNavKey} from '../../lib/shortcut-keys';

/** The sidebar's row order, rows folded away or behind "+ N older" included, in their place. */
function sidebarOrder(): string[] {
    const state = getState();
    return rowOrder(cursorTargets(state.sessionList, state.view.activePtyIds));
}

/** Whether the session has a terminal open whose process is still running. */
function isOpen(id: string): boolean {
    const entry = openSessions.get(id);
    return !!entry && !entry.closed;
}

/** Step through the open (not closed) sessions, in the order the sidebar lists their rows. */
function navigateSession(direction: -1 | 1): void {
    const next = stepOpenSession(sidebarOrder(), isOpen, getState().view.activeSessionId, direction);
    if (next) showSession(next);
}

export function handleSessionNavKey(e: KeyboardEvent): boolean {
    const direction = sessionNavDirection(e);
    if (direction === null) return false;
    e.preventDefault();
    if (e.type === 'keydown') navigateSession(direction);
    return true;
}

/** The session a swipe would go to, with the name its label shows. */
export interface SwipeNeighbour {
    readonly sessionId: string;
    readonly name: string;
}

/**
 * Where a sideways swipe on Claude's pane goes (#377): the session the keys
 * would step to, in the same order, except that at either end of the list
 * there is nothing there rather than a wrap round to the other end.
 */
export function swipeNeighbour(direction: -1 | 1): SwipeNeighbour | null {
    const sessionId = neighbourOpenSession(sidebarOrder(), isOpen, getState().view.activeSessionId, direction);
    if (!sessionId) return null;
    const session = sessionMap.get(sessionId) ?? openSessions.get(sessionId)?.session;
    return {sessionId, name: (session && headerNameFor(session)) || 'Untitled session'};
}

/** Put the session a swipe went to on screen, as the keys do. */
export function swipeToSession(direction: -1 | 1): void {
    const next = swipeNeighbour(direction);
    if (next) showSession(next.sessionId);
}
