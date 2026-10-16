/**
 * What the renderer does after the main process pushed something.
 *
 * The pushes arrive through the bridge (`ipc-bridge`) and the reducers record
 * what they change; what is left here is the follow-up that state alone does
 * not cover — re-keying the terminal registry, redrawing when a row changed
 * section, the scrollback banners, a debounced re-fetch. Each handler is a
 * store subscriber for one event, so it runs with the state already updated
 * and the state from before it in hand.
 *
 * Subscribers rather than functions the bridge calls, so the bridge stays a
 * plain event source and a React surface can later replace any one of these
 * by subscribing for itself. Installed before the question panel's listener,
 * which a re-key relies on (see `onSessionForked`).
 */
import { refreshSidebar, reloadProjects } from './refresh';
import { setActiveSession } from '../features/sessions/active-session';
import {
  dropPendingSession, writeExitBanner,
} from '../features/sessions/session-actions';
import { pollActiveSessions } from '../features/sessions/session-poller';
import { setHeaderIdentity, showHeaderNotice } from '../features/sessions/terminal-header';
import { handleRemoteStatus } from '../features/remote/connection-card';
import { busyChanged } from '../state/activity-slice';
import { onEvent } from '../state/app-store';
import { openSessions, pendingSessions, sessionMap } from '../state/session-store';
import type { RendererState } from '../state/root';

/**
 * How long to wait before re-fetching after a filesystem change.
 *
 * A CLI turn writes a burst of transcript lines; each one is a change event, and
 * re-fetching per event would fetch dozens of times for one answer.
 */
const PROJECTS_CHANGED_DEBOUNCE_MS = 300;

let projectsChangedTimer: ReturnType<typeof setTimeout> | null = null;

export function installIpcListeners(): void {
  onEvent('processExited', ({ sessionId, exitCode }) => onProcessExited(sessionId, exitCode));
  onEvent('sessionForked', ({ oldId, newId }, _state, previous) => onSessionForked(oldId, newId, previous));

  // A working↔ready flip moves the row between sections, and a row's section
  // is only recomputed by a render — the class alone would leave it stranded
  // under its old heading. Not a re-sort: the open session keeps its slot.
  onEvent('cliBusyState', ({ sessionId }, state, previous) => {
    if (busyChanged(previous.activity, state.activity, sessionId)) refreshSidebar();
  });
  onEvent('terminalNotification', ({ sessionId, message }, state, previous) => {
    // "Waiting for your input" settles the session; see `activityReducer`.
    if (busyChanged(previous.activity, state.activity, sessionId)) refreshSidebar();
    if (sessionId === state.view.activeSessionId) showHeaderNotice(message);
  });

  onEvent('remoteStatus', ({ sessionId, status }, _state, previous) => {
    handleRemoteStatus(sessionId, status, previous.remote.statuses[sessionId]);
  });
  onEvent('projectsChanged', onProjectsChanged);

  // Fullscreen hides the macOS traffic lights, so the space the collapsed
  // sidebar reserves for them is dead weight; the stylesheet reclaims it off this class.
  onEvent('fullscreenChanged', ({ isFullscreen }) => {
    document.documentElement.classList.toggle('fullscreen', isFullscreen);
  });
}

/**
 * A fork or an accepted plan re-keyed a running session.
 *
 * Everything holding the old id has to move across — the pending row too,
 * which has to follow so the sidebar entry survives until the store catches up.
 * The store has already moved the session's questions; the panel hears about
 * that after this has run, so it finds the terminal under the new id.
 */
function onSessionForked(oldId: string, newId: string, previous: RendererState): void {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (previous.view.activeSessionId === oldId) setActiveSession(newId);
  openSessions.delete(oldId);
  openSessions.set(newId, entry);

  const pending = pendingSessions.get(oldId);
  pendingSessions.delete(oldId);
  if (pending) {
    pending.session.sessionId = newId;
    pendingSessions.set(newId, pending);
  }
  sessionMap.delete(oldId);
  sessionMap.set(newId, entry.session);

  setHeaderIdentity(newId);
  void reloadProjects().then(() => {
    const row = selectRow(newId);
    const summary = row?.querySelector<HTMLElement>('.session-summary');
    if (summary) setHeaderIdentity(newId, summary.textContent);
  });
  void pollActiveSessions();
}

/** Mark a row as the one on screen, after a re-render has replaced it. */
function selectRow(sessionId: string): HTMLElement | null {
  const row = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  if (!row) return null;
  document.querySelectorAll<HTMLElement>('.session-item.active')
    .forEach(el => el.classList.remove('active'));
  row.classList.add('active');
  return row;
}

/**
 * A session's process ended.
 *
 * A plain terminal is ephemeral and goes immediately. A Claude session stays
 * mounted with its exit banner visible, so the user can read what happened —
 * the terminal is torn down when they click the row again.
 */
function onProcessExited(sessionId: string, exitCode: number): void {
  writeExitBanner(sessionId, exitCode);

  if (sessionMap.get(sessionId)?.type === 'terminal') {
    dropPendingSession(sessionId);
    sessionMap.delete(sessionId);
    refreshSidebar();
    void pollActiveSessions();
    return;
  }

  // Stamp the exit so the reconciliation pass can eventually tidy up a row no
  // real session was ever written for — see `isPendingAbandoned`.
  const pending = pendingSessions.get(sessionId);
  if (pending && !pending.exitedAt) pending.exitedAt = Date.now();

  void pollActiveSessions();
}

/** The transcripts on disk changed. */
function onProjectsChanged(): void {
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    void reloadProjects();
  }, PROJECTS_CHANGED_DEBOUNCE_MS);
}
