/**
 * Everything the main process pushes at the renderer.
 *
 * All in one place because the interesting part is not any single handler but
 * the fact that these are the only unprompted inputs the UI has — the terminal
 * stream, a session changing identity underneath us, a connection breaking, the
 * project list changing on disk. Each one delegates immediately; nothing is
 * decided here.
 */
import { refreshSidebar, reloadProjects } from './refresh';
import { setUpdaterEvent } from './updater-notice';
import { setStatusActivity } from './status-bar';
import { setActiveSession } from '../features/sessions/active-session';
import {
  clearScreen, dropPendingSession, writeExitBanner,
} from '../features/sessions/session-actions';
import { pollActiveSessions } from '../features/sessions/session-poller';
import { setHeaderIdentity, showHeaderNotice } from '../features/sessions/terminal-header';
import { handleRemoteStatus } from '../features/remote/connection-card';
import { markNeedsAttention, setActivity } from '../state/activity-store';
import { openSessions, pendingSessions, sessionMap, view } from '../state/session-store';
import { bufferTerminalData } from '../features/terminal/terminal-manager';
import { rekeyFilePanelState } from '../features/panel/file-panel';
import { updateGridCount } from '../features/terminal/grid-view';

/**
 * How long to wait before re-fetching after a filesystem change.
 *
 * A CLI turn writes a burst of transcript lines; each one is a change event, and
 * re-fetching per event would fetch dozens of times for one answer.
 */
const PROJECTS_CHANGED_DEBOUNCE_MS = 300;

/** Notifications that mean the CLI is waiting for a person. */
const NEEDS_ATTENTION = /attention|approval|permission|needs your|wants to enter/i;
/** …and the one that is really a late idle signal. */
const WAITING_FOR_INPUT = /waiting for your input/i;

let projectsChangedTimer: ReturnType<typeof setTimeout> | null = null;
let projectsChangedWhileAway = false;

export function installIpcListeners(): void {
  window.api.onTerminalData(bufferTerminalData);
  window.api.onProcessExited(onProcessExited);
  window.api.onSessionDetected(onSessionDetected);
  window.api.onSessionForked(onSessionForked);
  window.api.onCliBusyState(onCliBusyState);
  window.api.onTerminalNotification(onTerminalNotification);
  window.api.onRemoteStatus(handleRemoteStatus);
  window.api.onProjectsChanged(onProjectsChanged);
  window.api.onStatusUpdate(setStatusActivity);
  window.api.onUpdaterEvent(setUpdaterEvent);

  // Fullscreen hides the macOS traffic lights, so the space the sidebar header
  // reserves for them is dead weight; the stylesheet reclaims it off this class.
  window.api.onFullscreenChanged((isFullscreen) => {
    document.documentElement.classList.toggle('fullscreen', isFullscreen);
  });
}

/** True when a re-fetch is owed because a change arrived on another tab. */
export function consumeDeferredProjectsChange(): boolean {
  if (!projectsChangedWhileAway) return false;
  projectsChangedWhileAway = false;
  return true;
}

/**
 * A new session's real id, once Claude has written it.
 *
 * The renderer launched it under an id it invented, so everything holding that
 * id has to move across.
 */
function onSessionDetected(tempId: string, realId: string): void {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (view.activeSessionId === tempId) setActiveSession(realId);
  openSessions.delete(tempId);
  openSessions.set(realId, entry);

  setHeaderIdentity(realId, 'New session');
  void reloadProjects().then(() => selectRow(realId));
  void pollActiveSessions();
}

/**
 * A fork or an accepted plan re-keyed a running session.
 *
 * Same as above, plus the side panel's per-session state and the pending row,
 * which has to follow so the sidebar entry survives until the store catches up.
 */
function onSessionForked(oldId: string, newId: string): void {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (view.activeSessionId === oldId) setActiveSession(newId);
  openSessions.delete(oldId);
  openSessions.set(newId, entry);

  rekeyFilePanelState(oldId, newId);

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

  if (view.gridViewActive) updateGridCount();
  void pollActiveSessions();
}

function onCliBusyState(sessionId: string, busy: boolean): void {
  // A working↔ready flip moves the row between sections, and a row's section is
  // only recomputed by a render — toggling a class alone would leave it
  // stranded under its old heading. Not a re-sort: the open session keeps its
  // slot.
  if (setActivity(sessionId, busy)) refreshSidebar();
}

/**
 * A notification from the CLI.
 *
 * Four of the CLI's messages mean "a person is needed": needs your attention,
 * needs your approval for the plan, needs your permission to use a tool, and
 * wants to enter plan mode. A fifth — "waiting for your input" — is a late idle
 * signal rather than a request, so it settles the session instead of flagging
 * it.
 */
function onTerminalNotification(sessionId: string, message: string): void {
  if (NEEDS_ATTENTION.test(message)) {
    markNeedsAttention(sessionId);
  } else if (WAITING_FOR_INPUT.test(message)) {
    if (setActivity(sessionId, false)) refreshSidebar();
  }

  if (sessionId === view.activeSessionId) showHeaderNotice(message);
}

/**
 * The transcripts on disk changed.
 *
 * Deferred while the user is on another tab: re-fetching would be work nobody
 * can see, and the tab switch catches up.
 */
function onProjectsChanged(): void {
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
  if (view.activeTab !== 'sessions') {
    projectsChangedWhileAway = true;
    return;
  }
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    void reloadProjects();
  }, PROJECTS_CHANGED_DEBOUNCE_MS);
}

export { clearScreen };
