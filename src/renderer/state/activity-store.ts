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
 *
 * Anything that is not a row — a surface that counts sessions rather than
 * painting one — subscribes with `onActivityChange` instead.
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

type ActivityListener = (sessionId: string | null) => void;
const activityListeners = new Set<ActivityListener>();

/**
 * Be told when a session's activity state changes.
 *
 * The mutators below paint the affected row themselves, which is all the
 * session list needs. A surface that aggregates over sessions — the project
 * rail's running / waiting / unread badges — has no single row to paint and has
 * to recompute, so it is told instead. The id names the session that changed;
 * null means the set of live PTYs was rewritten by the poll, which can move any
 * number of sessions at once, so recompute everything.
 *
 * Returns the unsubscribe.
 */
export function onActivityChange(listener: ActivityListener): () => void {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
}

/**
 * Tell the listeners.
 *
 * Exported for the poller: `view.activePtyIds` is a signal this store reads but
 * does not own, so the store cannot notice that change itself.
 *
 * A listener that throws is logged and skipped. These run inside the mutators,
 * and a badge that fails to draw must not stop a row from being marked — or
 * take the listeners after it down with it.
 */
export function notifyActivityChanged(sessionId: string | null = null): void {
  for (const listener of [...activityListeners]) {
    try {
      listener(sessionId);
    } catch (err) {
      console.error('activity listener failed', err);
    }
  }
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

  notifyActivityChanged(sessionId);
  return wasActive !== active;
}

/** Mark a session as needing the user, unless they are already looking at it. */
export function markNeedsAttention(sessionId: string): void {
  if (sessionId === view.activeSessionId) return;
  attentionSessions.add(sessionId);
  rowFor(sessionId)?.classList.add('needs-attention');
  notifyActivityChanged(sessionId);
}

export function clearUnread(sessionId: string): void {
  responseReadySessions.delete(sessionId);
  rowFor(sessionId)?.classList.remove('response-ready');
  notifyActivityChanged(sessionId);
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
  notifyActivityChanged(sessionId);
}

export function isUnread(sessionId: string): boolean {
  return responseReadySessions.has(sessionId);
}

/**
 * Clear everything for a session — it stopped, or the row is going away.
 *
 * The poll calls this for every row without a live PTY, every few seconds, and
 * nearly all of those have nothing recorded. Only a session that actually had
 * state is announced, so a quiet list stays quiet for the listeners too.
 */
export function clearActivity(sessionId: string): void {
  const hadAttention = attentionSessions.delete(sessionId);
  const hadUnread = responseReadySessions.delete(sessionId);
  const hadBusy = sessionBusyState.delete(sessionId);
  rowFor(sessionId)?.classList.remove('needs-attention', 'response-ready', 'cli-busy');
  if (hadAttention || hadUnread || hadBusy) notifyActivityChanged(sessionId);
}

/** The user is now looking at this session, so nothing about it is unread. */
export function clearNotifications(sessionId: string): void {
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  rowFor(sessionId)?.classList.remove('needs-attention');
  notifyActivityChanged(sessionId);
}
