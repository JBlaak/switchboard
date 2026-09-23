/**
 * What each session currently wants from the user.
 *
 * Three states, and the transitions between them are the whole point:
 *
 *   working        a CLI turn is in flight
 *   ready          it finished, and the user has not looked yet
 *   needs input    it is blocked on the user (an OSC 9 notification)
 *
 * Two signals feed this. The OSC 0 title spinner is authoritative and comes
 * from the main process, which already de-duplicates it into transitions. The
 * OSC 9 notifications are what the CLI sends when it actually needs someone.
 *
 * The classes are toggled on the row directly as well as being recorded here,
 * because a state change usually does not warrant a re-render — but a
 * working↔ready flip moves the row between sections, and a row's section is
 * only recomputed by a render.
 */
import { sessionTier } from '../../domain/session/tiers';
import { pendingSessions, view } from './session-store';
import type { SessionSignals } from '../../domain/session/tiers';

/** Sessions blocked on the user, per OSC 9. */
export const attentionSessions = new Set<string>();
/** Sessions that finished a turn the user has not looked at. */
export const responseReadySessions = new Set<string>();
/** sessionId → whether a CLI turn is currently in flight. */
export const sessionBusyState = new Map<string, boolean>();

/** The live signals for one session, as the ranking rules want them. */
export function signalsFor(sessionId: string): SessionSignals {
  return {
    needsAttention: attentionSessions.has(sessionId),
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

function rowFor(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
}

/**
 * Record a busy↔idle transition.
 *
 * Answers true when the session moved between sections, so the caller knows a
 * re-render is owed. Only real transitions reach here — the main process
 * de-duplicates the title stream — so this stays cheap.
 */
export function setActivity(sessionId: string, active: boolean): boolean {
  // A turn starting again supersedes an unread answer: the row goes back to
  // working. Only an idle signal is ignored while unread — otherwise a late
  // idle repaint would clear a mark the user has not seen yet.
  if (responseReadySessions.has(sessionId)) {
    if (!active) return false;
    responseReadySessions.delete(sessionId);
    rowFor(sessionId)?.classList.remove('response-ready');
  }

  const wasActive = sessionBusyState.get(sessionId) === true;
  sessionBusyState.set(sessionId, active);

  // Activity ended → ready, but only if the user is not looking at it: a
  // session on screen has been read by definition.
  if (wasActive && !active && sessionId !== view.activeSessionId) {
    responseReadySessions.add(sessionId);
    const row = rowFor(sessionId);
    row?.classList.remove('cli-busy');
    row?.classList.add('response-ready');
  }

  if (!responseReadySessions.has(sessionId)) {
    rowFor(sessionId)?.classList.toggle('cli-busy', active);
  }

  return wasActive !== active;
}

/** Mark a session as needing the user, unless they are already looking at it. */
export function markNeedsAttention(sessionId: string): void {
  if (sessionId === view.activeSessionId) return;
  attentionSessions.add(sessionId);
  rowFor(sessionId)?.classList.add('needs-attention');
}

export function clearUnread(sessionId: string): void {
  responseReadySessions.delete(sessionId);
  rowFor(sessionId)?.classList.remove('response-ready');
}

/**
 * Put a session back into the ready state, as if Claude had just finished a
 * turn the user has not looked at.
 *
 * Mirrors the busy→idle transition in `setActivity`, so the sidebar re-renders
 * consistently.
 */
export function markUnread(sessionId: string): void {
  if (responseReadySessions.has(sessionId)) return;
  responseReadySessions.add(sessionId);
  sessionBusyState.set(sessionId, false);
  const row = rowFor(sessionId);
  row?.classList.remove('cli-busy');
  row?.classList.add('response-ready');
}

export function isUnread(sessionId: string): boolean {
  return responseReadySessions.has(sessionId);
}

/** Clear everything for a session — it stopped, or the row is going away. */
export function clearActivity(sessionId: string): void {
  attentionSessions.delete(sessionId);
  responseReadySessions.delete(sessionId);
  sessionBusyState.delete(sessionId);
  rowFor(sessionId)?.classList.remove('needs-attention', 'response-ready', 'cli-busy');
}

/** The user is now looking at this session, so nothing about it is unread. */
export function clearNotifications(sessionId: string): void {
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  rowFor(sessionId)?.classList.remove('needs-attention');
}
