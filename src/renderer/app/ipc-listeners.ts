/**
 * What the renderer does after the main process pushed something.
 *
 * The pushes arrive through the bridge (`ipc-bridge`) and the reducers record
 * what they change; what is left here is the follow-up that state alone does
 * not cover — re-keying the registries outside the store, laying the list out
 * again when a row changed section, the scrollback banners, a debounced
 * re-fetch. Each handler is a store subscriber for one event, so it runs with
 * the state already updated and the state from before it in hand.
 *
 * Subscribers rather than functions the bridge calls, so the bridge stays a
 * plain event source and a React surface can replace any one of these by
 * subscribing for itself. Installed before every other subscriber, which a
 * re-key relies on (see `onSessionForked`).
 */
import { loadProjects } from '../features/sessions/session-list';
import { relayoutSessionList } from '../ui/session-list/relayout';
import {
  dropPendingSession, writeExitBanner,
} from '../features/sessions/session-actions';
import { pollActiveSessions } from '../features/sessions/session-poller';
import { setHeaderIdentity } from '../features/sessions/terminal-header';
import { handleRemoteStatus } from '../features/remote/connection-log';
import { busyChanged } from '../state/activity-slice';
import { getState, onEvent } from '../state/app-store';
import { pendingSessions, sessionMap } from '../state/session-store';
import { rekeyRegistries } from './rekey-registries';
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
  onEvent('sessionForked', ({ oldId, newId }, state) => onSessionForked(oldId, newId, state));

  // A working↔ready flip moves the row between sections, and a row's section
  // is only recomputed by a render — the class alone would leave it stranded
  // under its old heading. Not a re-sort: the open session keeps its slot.
  onEvent('cliBusyState', ({ sessionId }, state, previous) => {
    if (busyChanged(previous.activity, state.activity, sessionId)) relayoutSessionList();
  });
  // The header shows the notice itself; see `terminal-slice`.
  onEvent('terminalNotification', ({ sessionId }, state, previous) => {
    // "Waiting for your input" settles the session; see `activityReducer`.
    if (busyChanged(previous.activity, state.activity, sessionId)) relayoutSessionList();
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
 * The store has already moved every slice; `rekeyRegistries` moves what lives
 * outside it, first, because everything after looks the session up under its
 * new id. Every other subscriber, the React tree's included, hears about the
 * re-key after this has run (see `bootstrap`), so it finds the terminal moved
 * too.
 *
 * The row keeps its local key across the re-key, so React keeps the same
 * element across the new layout: it stays in its slot and stays highlighted,
 * and only its id changes. The header is named from the row, now and again
 * once the fetch has brought the new transcript's title.
 */
function onSessionForked(oldId: string, newId: string, state: RendererState): void {
  rekeyRegistries(oldId, newId, state);
  relayoutSessionList();
  nameHeaderAfterRekey(newId);
  void loadProjects().then(() => nameHeaderAfterRekey(newId));
  void pollActiveSessions();
}

/** Put the re-keyed session's id and name in the header, if it is the one on screen. */
function nameHeaderAfterRekey(sessionId: string): void {
  if (getState().view.activeSessionId !== sessionId) return;
  const row = sessionMap.get(sessionId);
  if (row) setHeaderIdentity(row);
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
    relayoutSessionList();
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
    void loadProjects();
  }, PROJECTS_CHANGED_DEBOUNCE_MS);
}
