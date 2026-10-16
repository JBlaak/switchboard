/**
 * What each session currently wants from the user, as the vanilla code reads
 * it.
 *
 * The state and its rules live in the store now (see `activity-slice`); this
 * is the adapter that keeps the old reads and calls working. The four
 * collections are read-only views of the current state, and the remaining
 * calls dispatch.
 *
 * Nothing here writes to the DOM any more. The sidebar subscribes and puts the
 * classes on its rows itself (`features/sessions/sidebar-activity`).
 */
import { sessionTier } from '../../domain/session/tiers';
import { dispatch, getState } from './app-store';
import { pendingSessions, view } from './session-store';
import { askingCount } from './question-store';
import { hasEntry } from './records';
import type { SessionSignals } from '../../domain/session/tiers';
import type { WorkingAgent } from '../../domain/terminal/program-status-children';

/** Sessions blocked on the user, per OSC 9. */
export const attentionSessions = {
  has: (sessionId: string): boolean => hasEntry(getState().activity.attention, sessionId),
};
/** Sessions that finished a turn the user has not looked at. */
export const responseReadySessions = {
  has: (sessionId: string): boolean => hasEntry(getState().activity.ready, sessionId),
};
/** sessionId → whether a CLI turn is currently in flight. */
export const sessionBusyState = {
  get: (sessionId: string): boolean | undefined => getState().activity.busy[sessionId],
};
/** sessionId → the subagents it has working. Absent means none. */
export const sessionAgents = {
  get: (sessionId: string): readonly WorkingAgent[] | undefined => getState().activity.agents[sessionId],
};

/** The live signals for one session, as the ranking rules want them. */
export function signalsFor(sessionId: string): SessionSignals {
  return {
    // A session asking questions is waiting on the user just as surely, and
    // stays so while it is on screen: it is cleared by the set settling.
    needsAttention: attentionSessions.has(sessionId) || askingCount(sessionId) > 0,
    responseReady: responseReadySessions.has(sessionId),
    busy: sessionBusyState.get(sessionId) === true,
    pending: pendingSessions.has(sessionId),
    hasLivePty: view.activePtyIds.has(sessionId),
  };
}

/** The block a session belongs in. */
export function tierOf(sessionId: string): number {
  return sessionTier(signalsFor(sessionId));
}

/** Clear everything for a session — it stopped, or the row is going away. */
export function clearActivity(sessionId: string): void {
  dispatch({ type: 'activityCleared', sessionId });
}

/** The user is now looking at this session, so nothing about it is unread. */
export function clearNotifications(sessionId: string): void {
  dispatch({ type: 'sessionViewed', sessionId });
}
