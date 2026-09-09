/**
 * Everything the main process pushes at the renderer.
 *
 * All in one place because the interesting part is not any single handler but
 * the fact that these are the only unprompted inputs the UI has — the terminal
 * stream, a session changing identity underneath us, a connection breaking, the
 * project list changing on disk, a session asking to edit a file. Each one
 * delegates immediately.
 *
 * The one decision made here rather than passed on is whether an arrival may
 * take the window, because that is a question about what the user is doing and
 * not about the surface being routed to. See `onProposedEdit`.
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
import { openReviewInCodeArea } from '../features/code/code-area';
import { rekeyReviewSession, withdrawEdit, withdrawEdits } from '../features/code/review-view';
import { setMainMode } from './main-mode';
import { updateGridCount } from '../features/terminal/grid-view';
import type { DiffRequest } from '../../domain/ide/ide-request';

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

  // The three the IDE bridge sends about proposed edits. `openFile` is not one
  // of them: a file the CLI merely wants shown still goes to the side panel,
  // and only the edits it is *waiting* on come to the review surface.
  window.api.onMcpOpenDiff(onProposedEdit);
  window.api.onMcpCloseTab(withdrawEdit);
  window.api.onMcpCloseAllDiffs(withdrawEdits);

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
 * A session is asking to change a file.
 *
 * The request is recorded whoever it belongs to — it is parked in the bridge
 * until somebody answers, so losing it here would leave the CLI waiting on a
 * review nobody can reach.
 *
 * **Only the session you are already in may take the window.** A diff arriving
 * from a session in another project, while the user is typing into this one,
 * must not yank the window out from under the keystroke — that is how an
 * accept gets clicked on an edit nobody read. Invariant 4 already covers the
 * other case: the sidebar row and the rail tile badge for attention, which is
 * how a request in a session you are not looking at announces itself, and
 * clicking that row brings its review up. For the session on screen the flip
 * *is* the announcement, and it is the same interruption the file panel already
 * made when it popped the split open on an incoming diff.
 *
 * `setMainMode` is a no-op with no active session, which is the right answer
 * there too: with the placeholder up there is no half to fold and nothing to
 * flip away from.
 */
function onProposedEdit(sessionId: string, diffId: string, data: DiffRequest): void {
  openReviewInCodeArea(sessionId, {
    diffId,
    filePath: data.oldFilePath,
    tabName: data.tabName,
    oldContent: data.oldContent,
    newContent: data.newContent,
  });

  if (sessionId === view.activeSessionId) setMainMode('code');
  else markNeedsAttention(sessionId);
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
 * Same as above, plus the side panel's per-session state, the review's, and the
 * pending row, which has to follow so the sidebar entry survives until the
 * store catches up.
 */
function onSessionForked(oldId: string, newId: string): void {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (view.activeSessionId === oldId) setActiveSession(newId);
  openSessions.delete(oldId);
  openSessions.set(newId, entry);

  rekeyFilePanelState(oldId, newId);
  // And the review, which is the one piece of per-session state that can still
  // be holding a parked CLI call: an answer addressed to the old id would find
  // nothing in the bridge, which has been re-keyed with the session.
  rekeyReviewSession(oldId, newId);

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
