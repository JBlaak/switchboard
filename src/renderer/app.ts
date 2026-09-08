import { escapeHtml } from './utils.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { launchTerminalSession, resolveDefaultSessionOptions, showAddProjectDialog, showProjectPickerDialog } from './dialogs.js';
import {
  el, gridViewer, gridViewerCount, memoryContent, memoryViewer, placeholder, planViewer,
  plansContent, searchBar, searchInput, settingsViewer, sidebarContent, statsContent,
  statsViewer, terminalArea, terminalHeader,
} from './dom.js';
import { initFilePanel, rekeyFilePanelState, setSessionMcpActive, switchPanel } from './file-panel.js';
import { gridCards, handleSessionNavKey, initGridObservers, showGridView, toggleGridView } from './grid-view.js';
import { ICONS } from './icons.js';
import { hideAllViewers, loadMemories, loadPlans, renderMemories, renderPlans } from './plans-memory-view.js';
import { openSettingsViewer } from './settings-panel.js';
import { renderSessionList } from './sidebar.js';
import { attentionSessions, openSessions, pendingSessions, remoteStatus, responseReadySessions, sessionBusyState, sessionMap, state } from './state.js';
import { loadStats } from './stats-view.js';
import { ESC_SYNC_END, ESC_SYNC_START, SYNC_BUFFER_TIMEOUT, applyTerminalFont, createTerminalEntry, destroySession, fitAndScroll, flushTerminalBuffer, isMac, safeFit, scheduleFlush, showSession, terminalWriteBuffers } from './terminal-manager.js';
import { TERMINAL_THEME, TERMINAL_THEMES, applyTerminalTheme, getTerminalTheme } from './terminal-themes.js';
import { cleanDisplayName, encodeProjectPath, formatDate, isPendingAbandoned, remoteStatusBanner, remoteStatusLabel, shortProjectPath } from './utils.js';
import type { GlobalSettings, Project, SessionRow } from '../shared/types.js';
import type { LaunchOptions } from './dialogs.js';
import type { PlanSummary, UpdaterEventData } from '../preload/index.js';
import type { UsageLimit } from '../main/claude-auth.js';
const statusBarInfo = el('status-bar-info');
const statusBarActivity = el('status-bar-activity');
const archiveToggle = el('archive-toggle');
const starToggle = el('star-toggle');
const terminalHeaderName = el('terminal-header-name');
const terminalHeaderId = el('terminal-header-id');
const terminalHeaderStatus = el('terminal-header-status');
const terminalHeaderShell = el('terminal-header-shell');
const terminalStopBtn = el('terminal-stop-btn');
const runningToggle = el('running-toggle');
const todayToggle = el('today-toggle');

// currentPlanContent, currentPlanFilePath, currentPlanFilename → plans-memory-view.js
const loadingStatus = el('loading-status');
const sessionFilters = el('session-filters');
const globalSettingsBtn = el('global-settings-btn');
const addProjectBtn = el('add-project-btn');
const newSessionBtn = el('new-session-btn');
const resortBtn = el('resort-btn');

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
export function setActiveSession(id: string | null): void {
  state.activeSessionId = id;
  if (id) sessionStorage.setItem('state.activeSessionId', id);
  else sessionStorage.removeItem('state.activeSessionId');
  // Update file panel to show this session's open files/diffs
  if (typeof switchPanel === 'function') switchPanel(id);
}
// Persist slug group expand state across reloads
export function getExpandedSlugs() {
  try { return new Set(JSON.parse(sessionStorage.getItem('expandedSlugs') || '[]')); } catch { return new Set(); }
}
export function saveExpandedSlugs() {
  const expanded: string[] = [];
  document.querySelectorAll<HTMLElement>('.slug-group:not(.collapsed)').forEach(g => { if (g.id) expanded.push(g.id); });
  sessionStorage.setItem('expandedSlugs', JSON.stringify(expanded));
}

// Bridge functions for settings-panel.js
// Fullscreen hides the macOS traffic lights, so the space the sidebar header reserves
// for them is dead weight — style.css reclaims it off this class.
window.api.onFullscreenChanged((isFullscreen) => {
  document.documentElement.classList.toggle('fullscreen', isFullscreen);
});


// --- Activity tracking ---
//
// Activity is determined by two signals:
//   1. OSC 0 braille spinner (authoritative: Claude CLI sets title to spinner chars)
//   2. Noise-filtered terminal output (fallback: non-noise, non-TUI-repaint data)
//
// Both feed into setActivity(sessionId, active):
//   active=true  → cli-busy (spinner dot)
//   active=false → response-ready if not focused (terminal state until user clicks)
// OSC 0 idle signal is the authoritative source for marking sessions as idle.
//

// Central activity dispatcher
function setActivity(sessionId: string, active: boolean): void {
  // A turn starting again supersedes an unread answer: the row goes back to
  // working. Only an idle signal is ignored while unread — otherwise a late
  // idle repaint would clear a mark the user hasn't seen yet.
  if (responseReadySessions.has(sessionId)) {
    if (!active) return;
    responseReadySessions.delete(sessionId);
    const readyItem = document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
    if (readyItem) readyItem.classList.remove('response-ready');
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  if (wasActive && !active) {
    // Activity ended → response-ready if user isn't looking at this session
    if (sessionId !== state.activeSessionId) {
      responseReadySessions.add(sessionId);
      const item = document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
      if (item) {
        item.classList.remove('cli-busy');
        item.classList.add('response-ready');
      }
    }
  }

  // Sync cli-busy class (only if not response-ready)
  if (!responseReadySessions.has(sessionId)) {
    const item = document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.toggle('cli-busy', active);
  }

  // A busy↔idle flip moves the session between the Working and Ready blocks, and
  // a row's block is only recomputed by a render — toggling a class alone would
  // leave it stranded under its old heading. Not a re-sort: the open session
  // keeps its slot. Only real transitions reach here (the main process dedupes),
  // so this stays cheap.
  if (wasActive !== active) refreshSidebar();
}

export function clearUnread(sessionId: string): void {
  responseReadySessions.delete(sessionId);
  const item = document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
  if (item) {
    item.classList.remove('response-ready');
  }
}

// User-initiated: put a session back into the response-ready state, as if
// Claude had just finished a turn the user hasn't looked at yet. Mirrors the
// busy→idle transition in setActivity so the sidebar re-renders consistently.
export function markUnread(sessionId: string): void {
  if (responseReadySessions.has(sessionId)) return;
  responseReadySessions.add(sessionId);
  sessionBusyState.set(sessionId, false);
  const item = document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
  if (item) {
    item.classList.remove('cli-busy');
    item.classList.add('response-ready');
  }
}

export function clearNotifications(sessionId: string): void {
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  const item = document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('needs-attention');
}
// Terminal themes, utils (cleanDisplayName, formatDate, escapeHtml, shellEscape)
// are defined in terminal-themes.js and utils.js (loaded before app.js).

// Terminal key bindings, write buffering, isAtBottom, safeFit, fitAndScroll → terminal-manager.js

// --- IPC listeners from main process ---

window.api.onTerminalData((sessionId, data) => {
  const entry = openSessions.get(sessionId);
  if (entry) {
    let buf = terminalWriteBuffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], syncDepth: 0, rafId: 0, timerId: 0 as unknown as ReturnType<typeof setTimeout> };
      terminalWriteBuffers.set(sessionId, buf);
    }
    const b = buf;
    b.chunks.push(data);

    // Track sync start/end nesting
    if (data.includes(ESC_SYNC_START)) b.syncDepth++;
    if (data.includes(ESC_SYNC_END)) b.syncDepth = Math.max(0, b.syncDepth - 1);

    if (b.syncDepth > 0) {
      // Inside a synchronized update — keep buffering.
      // Set a safety timeout so we never hold data forever.
      cancelAnimationFrame(b.rafId);
      if (!b.timerId) {
        b.timerId = setTimeout(() => flushTerminalBuffer(sessionId), SYNC_BUFFER_TIMEOUT);
      }
    } else {
      // Not in a sync block (or sync just ended) — flush on next frame.
      clearTimeout(b.timerId);
      b.timerId = 0 as unknown as ReturnType<typeof setTimeout>;
      scheduleFlush(sessionId, b);
    }
  }
});

window.api.onSessionDetected((tempId, realId) => {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (state.activeSessionId === tempId) setActiveSession(realId);

  // Re-key in openSessions
  openSessions.delete(tempId);
  openSessions.set(realId, entry);

  terminalHeaderId.textContent = realId;
  terminalHeaderName.textContent = 'New session';

  // Refresh sidebar to show the new session, then select it
  loadProjects().then(() => {
    const item = document.querySelector<HTMLElement>(`[data-session-id="${realId}"]`);
    if (item) {
      document.querySelectorAll<HTMLElement>('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    }
  });
  pollActiveSessions();
});

window.api.onSessionForked((oldId, newId) => {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (state.activeSessionId === oldId) setActiveSession(newId);

  openSessions.delete(oldId);
  openSessions.set(newId, entry);

  // Re-key file panel state for the new session ID
  if (typeof rekeyFilePanelState === 'function') rekeyFilePanelState(oldId, newId);

  // Re-key pending session to newId so sidebar item persists until DB has real data
  const pendingEntry = pendingSessions.get(oldId);
  pendingSessions.delete(oldId);
  if (pendingEntry) {
    pendingEntry.session.sessionId = newId;
    pendingSessions.set(newId, pendingEntry);
  }
  sessionMap.delete(oldId);
  sessionMap.set(newId, entry.session);

  terminalHeaderId.textContent = newId;

  loadProjects().then(() => {
    const item = document.querySelector<HTMLElement>(`[data-session-id="${newId}"]`);
    if (item) {
      document.querySelectorAll<HTMLElement>('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      const summary = item.querySelector<HTMLElement>('.session-summary');
      if (summary) terminalHeaderName.textContent = summary.textContent;
    }
  });
  pollActiveSessions();
});

window.api.onProcessExited((sessionId, exitCode) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  if (entry) {
    entry.closed = true;
    // Write a visible exit banner so the user can see when the process ended
    // and read any error output it printed (claude / devbox / shell stderr).
    // Without this, a fast-failing pre-launch command would tear down the
    // terminal before the user could read the error.
    try {
      const colour = exitCode === 0 ? '\x1b[2m' : '\x1b[33m';
      entry.terminal.write(
        `\r\n${colour}── session exited (code ${exitCode}) ──\x1b[0m\r\n`
      );
    } catch {}
  }

  // Plain terminal sessions are ephemeral — destroy immediately and remove from
  // the sidebar. Claude sessions stay mounted (see below) so the user can read
  // the exit reason.
  if (session?.type === 'terminal') {
    if (entry) destroySession(sessionId);
    if (state.gridViewActive) {
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    } else if (state.activeSessionId === sessionId) {
      setActiveSession(null);
      terminalHeader.style.display = 'none';
      placeholder.style.display = '';
    }
    pendingSessions.delete(sessionId);
    for (const projList of [state.cachedProjects, state.cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
    pollActiveSessions();
    return;
  }

  // Claude sessions: keep the terminal mounted with the exit banner visible so
  // the user can read what happened. Cleanup is deferred — openSession destroys
  // the closed entry when the user re-clicks the session (existing behavior).
  // If the session was pending (no .jsonl was written), leave the sidebar entry
  // in place too so the user has somewhere to relaunch from; stamping the exit
  // starts the clock that isPendingAbandoned reads, so it's tidied up by the
  // reconciliation pass once it's clear no real session file is coming.
  const pending = pendingSessions.get(sessionId);
  if (pending && !pending.exitedAt) pending.exitedAt = Date.now();

  if (state.gridViewActive) {
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  }

  pollActiveSessions();
});

// --- Remote (SSH) connection status ---
// A remote session's terminal is empty until ssh says something, and ssh can
// take a long time to say anything (a sleeping host, a 1Password approval, a
// banner exchange that never completes). Without a status of its own the screen
// is indistinguishable from a frozen app — which is exactly what a slow or
// failing connect looked like.
//
// Two surfaces, deliberately: a card over the terminal carries the live state
// (what we're doing, to which host, how long it has left, what you can do about
// it), and the scrollback keeps a one-line record of each break so the reason is
// still there afterwards. Reconnects are driven by the main process; the
// renderer only narrates them.

let remoteTicker: ReturnType<typeof setInterval> | null = null;

// ssh gives up on a handshake at this point (ConnectTimeout in
// remote-projects.js), which is what the connecting bar fills toward.
const REMOTE_CONNECT_TIMEOUT_MS = 10000;
const CONNECTED_FLASH_MS = 500;

// The card is built per session, lazily — local sessions never pay for it — and
// lives inside the terminal container so it follows the terminal into a grid
// card without any extra plumbing.
function ensureRemoteCard(sessionId: string): HTMLElement | null {
  const entry = openSessions.get(sessionId);
  if (!entry) return null;
  if (entry.remoteCard) return entry.remoteCard as HTMLElement;

  const el = document.createElement('div');
  el.className = 'rc';
  el.hidden = true;
  el.innerHTML = `
    <div class="rc-card">
      <svg class="rc-link" viewBox="0 0 220 58" aria-hidden="true">
        <rect class="rc-node" x="11" y="18" width="38" height="26" rx="5"/>
        <circle class="rc-node-mark" cx="30" cy="31" r="4"/>
        <path class="rc-wire" d="M55 31H165"/>
        <path class="rc-flow" d="M55 31H165"/>
        <circle class="rc-spark" cx="55" cy="31" r="3.5"/>
        <g class="rc-break">
          <path d="M103 22l14 18"/>
          <path d="M117 22l-14 18"/>
        </g>
        <rect class="rc-node" x="171" y="18" width="38" height="26" rx="5"/>
        <path class="rc-node-mark" d="M178 25h24M178 31h24M178 37h15"/>
      </svg>
      <div class="rc-status"></div>
      <div class="rc-target"></div>
      <div class="rc-bar"><i></i></div>
      <div class="rc-detail"></div>
      <div class="rc-actions">
        <button class="rc-retry" type="button">Retry now</button>
        <button class="rc-cancel" type="button">Stop trying</button>
      </div>
    </div>`;

  el.querySelector<HTMLElement>('.rc-retry')!.addEventListener('click', () => retryRemote(sessionId));
  el.querySelector<HTMLElement>('.rc-cancel')!.addEventListener('click', () => {
    // The tmux session on the far end is untouched by this, so there is nothing
    // to confirm — it only stops Switchboard dialling.
    window.api.stopSession(sessionId);
  });

  entry.element.appendChild(el);
  entry.remoteCard = el;
  return el;
}

// "Retry now". While the session is still held by the main process this just
// short-circuits the backoff; once it has been retired (retries exhausted, so
// the row went back to Stopped) the only way back is a fresh open.
async function retryRemote(sessionId: string): Promise<void> {
  const entry = openSessions.get(sessionId);
  if (entry && !entry.closed) {
    const res = await window.api.reconnectRemote(sessionId).catch(() => null);
    if (res && res.ok) return;
  }
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  if (session) openSession(session);
}

function hideRemoteCard(sessionId: string): void {
  const entry = openSessions.get(sessionId);
  const card = entry?.remoteCard as HTMLElement | undefined;
  if (card) card.hidden = true;
}

// Restart a CSS bar animation. Re-assigning a class does not replay keyframes,
// so the element is swapped for a clone — the one reliable way to retrigger.
function restartRemoteBar(card: HTMLElement | null, durationMs: number): void {
  if (!card) return;
  const bar = card.querySelector<HTMLElement>('.rc-bar');
  if (!bar) return;
  const fresh = bar.querySelector<HTMLElement>('i')?.cloneNode(false);
  if (!fresh) return;
  bar.replaceChildren(fresh);
  bar.style.setProperty('--rc-duration', durationMs + 'ms');
}

// Everything the card shows is derived from the stored status plus the clock, so
// the per-second tick is just this function again.
function renderRemoteCard(sessionId: string): void {
  const status = remoteStatus.get(sessionId);
  if (!status) return;
  const card = ensureRemoteCard(sessionId);
  if (!card) return;

  const target = status.target || 'the remote host';
  const attemptOf = status.maxAttempts
    ? `attempt ${status.attempt} of ${status.maxAttempts}`
    : '';

  card.classList.remove('is-connecting', 'is-retrying', 'is-failed', 'is-connected');
  card.querySelector<HTMLElement>('.rc-target')!.textContent = target;

  if (status.phase === 'connecting') {
    const secs = Math.floor((Date.now() - (status.startedAt ?? Date.now())) / 1000);
    card.classList.add('is-connecting');
    card.querySelector<HTMLElement>('.rc-status')!.textContent = status.attempt ? 'Reconnecting' : 'Connecting';
    // Counting up toward a limit the user can see coming beats an
    // indeterminate spinner that could mean anything.
    card.querySelector<HTMLElement>('.rc-detail')!.textContent =
      [attemptOf, secs >= 1 ? `${secs}s` : ''].filter(Boolean).join(' · ');
  } else if (status.phase === 'retrying') {
    const secs = Math.max(0, Math.ceil(((status.retryAt ?? 0) - Date.now()) / 1000));
    card.classList.add('is-retrying');
    card.querySelector<HTMLElement>('.rc-status')!.textContent =
      secs > 0 ? `Reconnecting in ${secs}s` : 'Reconnecting…';
    card.querySelector<HTMLElement>('.rc-detail')!.textContent =
      [status.reason, attemptOf].filter(Boolean).join(' · ');
  } else if (status.phase === 'failed') {
    card.classList.add('is-failed');
    card.querySelector<HTMLElement>('.rc-status')!.textContent =
      status.everConnected ? 'Lost connection' : 'Could not connect';
    card.querySelector<HTMLElement>('.rc-detail')!.textContent = status.reason || '';
  } else if (status.phase === 'connected') {
    card.classList.add('is-connected');
    card.querySelector<HTMLElement>('.rc-status')!.textContent = 'Connected';
    card.querySelector<HTMLElement>('.rc-detail')!.textContent = '';
  }

  card.hidden = false;
}

// One shared tick for every card and the header, running only while some
// session is mid-connect. Whole seconds are all any of them show.
function syncRemoteTicker() {
  const live = [...remoteStatus.values()].some(s => s.phase === 'connecting' || s.phase === 'retrying');
  if (live && !remoteTicker) {
    remoteTicker = setInterval(() => {
      for (const [id, s] of remoteStatus) {
        if (s.phase === 'connecting' || s.phase === 'retrying') renderRemoteCard(id);
      }
      updateTerminalHeader();
      syncRemoteTicker();
    }, 1000);
  } else if (!live && remoteTicker) {
    clearInterval(remoteTicker);
    remoteTicker = null;
  }
}

// A permanent line in the scrollback, in the same dim rule as the session-exit
// banner so status reads as chrome rather than output from the remote host.
function writeTerminalStatusLine(sessionId: string, text: string, colour = '\x1b[2m'): void {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  try {
    entry.terminal.write(remoteStatusBanner(text, colour));
  } catch {}
}

window.api.onRemoteStatus((sessionId, status) => {
  const previous = remoteStatus.get(sessionId);
  const target = status.target || 'the remote host';

  switch (status.phase) {
    case 'connecting':
      // startedAt is stamped here so the card can count up without main having
      // to send a tick every second.
      remoteStatus.set(sessionId, { ...status, startedAt: Date.now() });
      renderRemoteCard(sessionId);
      restartRemoteBar(ensureRemoteCard(sessionId), REMOTE_CONNECT_TIMEOUT_MS);
      break;

    case 'connected':
      remoteStatus.set(sessionId, status);
      // A brief green beat so a reconnect is visibly resolved rather than the
      // card just vanishing; on a first connect the tmux repaint says it well
      // enough, so the card goes straight away.
      if (previous && previous.attempt) {
        renderRemoteCard(sessionId);
        writeTerminalStatusLine(sessionId, 'reconnected');
        setTimeout(() => {
          if (remoteStatus.get(sessionId)?.phase === 'connected') hideRemoteCard(sessionId);
        }, CONNECTED_FLASH_MS);
      } else {
        hideRemoteCard(sessionId);
      }
      break;

    case 'retrying':
      remoteStatus.set(sessionId, { ...status, retryAt: Date.now() + (status.delayMs ?? 0) });
      // The reason also goes to the scrollback, where it survives the next
      // reconnect — the card only ever shows the break it is currently on.
      writeTerminalStatusLine(sessionId, status.everConnected
        ? `connection lost: ${status.reason}`
        : `could not reach ${target}: ${status.reason}`, '\x1b[33m');
      renderRemoteCard(sessionId);
      restartRemoteBar(ensureRemoteCard(sessionId), status.delayMs ?? 0);
      break;

    case 'failed':
      remoteStatus.set(sessionId, status);
      writeTerminalStatusLine(sessionId,
        `gave up ${status.everConnected ? 'reconnecting to' : 'connecting to'} ${target}`,
        '\x1b[33m');
      renderRemoteCard(sessionId);
      break;

    case 'disconnected':
      remoteStatus.delete(sessionId);
      hideRemoteCard(sessionId);
      break;
  }

  syncRemoteTicker();
  if (sessionId === state.activeSessionId) updateTerminalHeader();
});

// --- Terminal notifications (iTerm2 OSC 9 — "needs attention") ---
window.api.onTerminalNotification((sessionId, message) => {
  // Only mark as needing attention for "attention" messages, not "waiting for input"
  // Matches all four CLI notification types:
  // 1. "Claude Code needs your attention"         → attention
  // 2. "Claude Code needs your approval for the plan" → approval, needs your
  // 3. "Claude needs your permission to use {tool}"   → permission, needs your
  // 4. "Claude Code wants to enter plan mode"         → wants to enter
  if (/attention|approval|permission|needs your|wants to enter/i.test(message) && sessionId !== state.activeSessionId) {
    attentionSessions.add(sessionId);
    const item = document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('needs-attention');
  } else if (/waiting for your input/i.test(message)) {
    // "Claude is waiting for your input" — delayed idle notification, mark response-ready
    setActivity(sessionId, false);
  }

  // Show in header if active
  if (sessionId === state.activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- CLI busy state (OSC 0 title spinner detection) ---
window.api.onCliBusyState((sessionId, busy) => {
  setActivity(sessionId, busy);
});

// --- Single entry point for all sidebar renders ---
// The sidebar is one flat list of sessions, ordered by what each session wants
// from the user (see sidebar.js) and by most recent activity inside each block.
// resort=true: nothing is held back — the open session moves to its true
//   position too (use for user-initiated actions, e.g. the re-sort button)
// resort=false (default): the open session keeps the slot it already had, so
//   the list can't slide out from under the cursor while it reorders
export function refreshSidebar({ resort = false } = {}) {
  // When searching, always use all projects (search ignores archive filter)
  let projects = (state.searchMatchIds !== null)
    ? state.cachedAllProjects
    : (state.showArchived ? state.cachedAllProjects : state.cachedProjects);

  const matchIds = state.searchMatchIds;
  if (matchIds !== null) {
    projects = projects.map((p): Project | null => {
      const hasMatchingSessions = p.sessions.some(s => matchIds.has(s.sessionId));
      const projectMatched = state.searchMatchProjectPaths && state.searchMatchProjectPaths.has(p.projectPath);
      if (!hasMatchingSessions && !projectMatched) return null;
      // A project whose name matches contributes all of its sessions — there
      // is no directory header left to stand in for the project itself.
      return {
        ...p,
        sessions: hasMatchingSessions ? p.sessions.filter(s => matchIds.has(s.sessionId)) : p.sessions,
      };
    }).filter((p): p is Project => p !== null);
  }

  renderSessionList(projects, resort);
}

// --- Archive toggle ---
archiveToggle.innerHTML = ICONS.archive(18);
archiveToggle.addEventListener('click', () => {
  state.showArchived = !state.showArchived;
  if (state.showArchived) {
    state.showStarredOnly = false; starToggle.classList.remove('active');
    state.showRunningOnly = false; runningToggle.classList.remove('active');
  }
  archiveToggle.classList.toggle('active', state.showArchived);
  refreshSidebar({ resort: true });
});

// --- Star filter toggle ---
starToggle.addEventListener('click', () => {
  state.showStarredOnly = !state.showStarredOnly;
  if (state.showStarredOnly) {
    state.showRunningOnly = false; runningToggle.classList.remove('active');
    state.showArchived = false; archiveToggle.classList.remove('active');
  }
  starToggle.classList.toggle('active', state.showStarredOnly);
  refreshSidebar({ resort: true });
});

// --- Running filter toggle ---
runningToggle.addEventListener('click', () => {
  state.showRunningOnly = !state.showRunningOnly;
  if (state.showRunningOnly) {
    state.showStarredOnly = false; starToggle.classList.remove('active');
    state.showArchived = false; archiveToggle.classList.remove('active');
  }
  runningToggle.classList.toggle('active', state.showRunningOnly);
  refreshSidebar({ resort: true });
});

// --- Today filter toggle ---
todayToggle.addEventListener('click', () => {
  state.showTodayOnly = !state.showTodayOnly;
  todayToggle.classList.toggle('active', state.showTodayOnly);
  refreshSidebar({ resort: true });
});

// --- Re-sort button ---
resortBtn.addEventListener('click', () => {
  loadProjects({ resort: true });
});

// --- Global settings gear button ---
globalSettingsBtn.innerHTML = ICONS.gear(18);
globalSettingsBtn.addEventListener('click', () => {
  openSettingsViewer('global');
});

// --- Add project button ---
addProjectBtn.addEventListener('click', () => {
  showAddProjectDialog();
});

// --- New session: pick the project to start it in ---
newSessionBtn.addEventListener('click', () => {
  showProjectPickerDialog();
});

// --- Search (debounced, per-tab FTS) ---
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const searchClear = el('search-clear');
const searchTitlesToggle = el('search-titles-toggle');
let searchTitlesOnly = false;

// Load persisted preference
(async () => {
  const saved = await window.api.getSetting('searchTitlesOnly');
  if (saved) {
    searchTitlesOnly = true;
    searchTitlesToggle.classList.add('active');
  }
})();

searchTitlesToggle.addEventListener('click', async () => {
  searchTitlesOnly = !searchTitlesOnly;
  searchTitlesToggle.classList.toggle('active', searchTitlesOnly);
  await window.api.setSetting('searchTitlesOnly', searchTitlesOnly);
  // Re-run current search if there's a query
  const query = searchInput.value.trim();
  if (query) {
    searchInput.dispatchEvent(new Event('input'));
  }
});

function clearSearch() {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  if (state.activeTab === 'sessions') {
    state.searchMatchIds = null;
    state.searchMatchProjectPaths = null;
    refreshSidebar({ resort: true });
  } else if (state.activeTab === 'plans') {
    renderPlans(state.cachedPlans);
  } else if (state.activeTab === 'memory') {
    renderMemories();
  }
}

searchClear.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

searchInput.addEventListener('input', () => {
  // Toggle clear button visibility
  searchBar.classList.toggle('has-query', searchInput.value.length > 0);

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null;
    const query = searchInput.value.trim();

    if (!query) {
      clearSearch();
      return;
    }

    try {
      if (state.activeTab === 'sessions') {
        const results = await window.api.search('session', query, searchTitlesOnly);
        state.searchMatchIds = new Set(results.map(r => r.id));
        // When title-only, also match project names
        state.searchMatchProjectPaths = null;
        if (searchTitlesOnly) {
          const lowerQ = query.toLowerCase();
          for (const p of state.cachedAllProjects) {
            const shortName = shortProjectPath(p.projectPath);
            if (shortName.toLowerCase().includes(lowerQ)) {
              if (!state.searchMatchProjectPaths) state.searchMatchProjectPaths = new Set();
              state.searchMatchProjectPaths.add(p.projectPath);
            }
          }
        }
        refreshSidebar({ resort: true });
      } else if (state.activeTab === 'plans') {
        const results = await window.api.search('plan', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(state.cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (state.activeTab === 'memory') {
        const results = await window.api.search('memory', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderMemories(matchIds);
      }
    } catch {
      if (state.activeTab === 'sessions') {
        state.searchMatchIds = null;
        state.searchMatchProjectPaths = null;
        refreshSidebar({ resort: true });
      }
    }
  }, 200);
});

// --- Stop session helper ---
export async function confirmAndStopSession(sessionId: string): Promise<void> {
  const isRemote = sessionMap.get(sessionId)?.type === 'remote';
  const prompt = isRemote
    ? 'Disconnect? The session keeps running on the remote machine.'
    : 'Stop this session?';
  if (!confirm(prompt)) return;
  await window.api.stopSession(sessionId);
  state.activePtyIds.delete(sessionId);
  if (!state.gridViewActive && state.activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }
  refreshSidebar();
}

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', () => {
  if (state.activeSessionId) confirmAndStopSession(state.activeSessionId);
});


// --- Poll for active PTY sessions ---
// Adaptive cadence: poll fast (3s) only while PTYs are running; when idle, back
// off to 30s. Every renderer path that starts a session (launchNewSession,
// openSession, launchTerminalSession, onSessionDetected/Forked) calls
// pollActiveSessions() explicitly, which re-arms the fast cadence immediately.
// The 30s idle floor still catches sessions started outside the renderer
// (scheduler-spawned PTYs, other windows) within at most 30s.
const POLL_FAST_MS = 3000;
const POLL_IDLE_MS = 30000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleActiveSessionsPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = state.activePtyIds.size > 0 ? POLL_FAST_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(pollActiveSessions, delay);
}

export async function pollActiveSessions() {
  try {
    const ids = await window.api.getActiveSessions();
    state.activePtyIds = new Set(ids);
    updateRunningIndicators();
    updateTerminalHeader();
  } catch {}
  scheduleActiveSessionsPoll();
}

export function updateRunningIndicators(): void {
  document.querySelectorAll<HTMLElement>('.session-item').forEach(item => {
    const id = item.dataset.sessionId;
    if (!id) return;
    const running = state.activePtyIds.has(id);
    item.classList.toggle('has-running-pty', running);
    if (!running) {
      item.classList.remove('needs-attention', 'response-ready', 'cli-busy');
      attentionSessions.delete(id);
      responseReadySessions.delete(id);
      sessionBusyState.delete(id);
    }
    const dot = item.querySelector<HTMLElement>('.session-status-dot');
    if (dot) dot.classList.toggle('running', running);
  });
  // Update slug group running dots
  document.querySelectorAll<HTMLElement>('.slug-group').forEach(group => {
    const hasRunning = group.querySelector<HTMLElement>('.session-item.has-running-pty') !== null;
    const dot = group.querySelector<HTMLElement>('.slug-group-dot');
    if (dot) dot.classList.toggle('running', hasRunning);
  });
  // Update grid card dots and status text
  for (const [sid, card] of gridCards) {
    const running = state.activePtyIds.has(sid);
    const busy = sessionBusyState.get(sid) || false;
    const dot = card.querySelector<HTMLElement>('.grid-card-dot');
    if (dot) dot.className = 'grid-card-dot ' + (busy ? 'busy' : (running ? 'running' : 'stopped'));
    const footer = card.querySelector<HTMLElement>('.grid-card-footer');
    if (footer) footer.children[0].textContent = running ? 'Running' : 'Stopped';
    const stopBtn = card.querySelector<HTMLElement>('.grid-card-stop-btn');
    if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  }
}

function updateTerminalHeader() {
  if (!state.activeSessionId) return;
  const running = state.activePtyIds.has(state.activeSessionId);
  // While a remote session is connecting or waiting out a reconnect it is
  // neither running nor stopped, and saying either is misleading.
  const connectingLabel = remoteStatusLabel(remoteStatus.get(state.activeSessionId), Date.now());
  if (connectingLabel) {
    terminalHeaderStatus.className = 'connecting';
    terminalHeaderStatus.textContent = connectingLabel;
  } else {
    terminalHeaderStatus.className = running ? 'running' : 'stopped';
    terminalHeaderStatus.textContent = running ? 'Running' : 'Stopped';
  }
  terminalStopBtn.style.display = running ? '' : 'none';
  updatePtyTitle();
}

const terminalHeaderPtyTitle = el('terminal-header-pty-title');

export function updatePtyTitle() {
  if (!state.activeSessionId || !terminalHeaderPtyTitle) return;
  const entry = openSessions.get(state.activeSessionId);
  const title = entry?.ptyTitle || '';
  terminalHeaderPtyTitle.textContent = title;
  terminalHeaderPtyTitle.style.display = title ? '' : 'none';
}

scheduleActiveSessionsPoll();

// Refresh sidebar timeago labels every 30s so "just now" ticks forward
setInterval(() => {
  for (const [sessionId, session] of sessionMap) {
    if (!session.modified) continue;
    const item = document.getElementById('si-' + sessionId);
    if (!item) continue;
    const timeEl = item.querySelector<HTMLElement>('.session-time');
    if (!timeEl) continue;
    const msgSuffix = session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '';
    timeEl.textContent = formatDate(new Date(session.modified)) + msgSuffix;
  }
}, 30000);

// Shared session map so all caches reference the same objects

/**
 * A stand-in project for the two call sites that only have a path.
 *
 * `launchTerminalSession` and `resolveDefaultSessionOptions` read nothing but
 * `projectPath`; building the rest would be inventing data.
 */
function projectFor(projectPath: string): Project {
  return { projectPath, folder: encodeProjectPath(projectPath), sessions: [] };
}

function dedup(projects: Project[]): void {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i];
      if (sessionMap.has(s.sessionId)) {
        Object.assign(sessionMap.get(s.sessionId)!, s);
        p.sessions[i] = sessionMap.get(s.sessionId)!;
      } else {
        sessionMap.set(s.sessionId, s);
      }
    }
  }
}

export async function loadProjects({ resort = false } = {}) {
  const wasEmpty = state.cachedProjects.length === 0;
  if (wasEmpty) {
    loadingStatus.textContent = 'Loading\u2026';
    loadingStatus.className = 'active';
    loadingStatus.style.display = '';
  }
  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);
  state.cachedProjects = defaultProjects;
  state.cachedAllProjects = allProjects;
  loadingStatus.style.display = 'none';
  loadingStatus.className = '';
  dedup(state.cachedProjects);
  dedup(state.cachedAllProjects);

  // Reconcile pending sessions: remove ones that now have real data, and the
  // ones no real data is ever coming for.
  let hasReinjected = false;
  for (const [sid, pending] of [...pendingSessions]) {
    const realExists = allProjects.some(p => p.sessions.some(s => s.sessionId === sid));
    if (realExists) {
      pendingSessions.delete(sid);
    } else if (isPendingAbandoned(pending, {
      running: state.activePtyIds.has(sid),
      onScreen: state.activeSessionId === sid,
    })) {
      dropPendingSession(sid);
    } else {
      hasReinjected = true;
      // Still pending — re-inject into cached data
      for (const projList of [state.cachedProjects, state.cachedAllProjects]) {
        let proj = projList.find(p => p.projectPath === pending.projectPath);
        if (!proj) {
          // Project not in list (no other sessions) — create a synthetic entry
          proj = { folder: pending.folder, projectPath: pending.projectPath, sessions: [] };
          projList.unshift(proj);
        }
        if (!proj.sessions.some(s => s.sessionId === sid)) {
          proj.sessions.unshift(pending.session);
        }
      }
    }
  }

  // Track active plain terminals in pendingSessions/sessionMap (data now comes from backend)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = encodeProjectPath(projectPath);
      // Find the session object already injected by the backend
      let session;
      for (const proj of state.cachedAllProjects) {
        session = proj.sessions.find(s => s.sessionId === sessionId);
        if (session) break;
      }
      if (!session) continue;
      pendingSessions.set(sessionId, { session, projectPath, folder });
      sessionMap.set(sessionId, session);
    }
  } catch {}

  await pollActiveSessions();
  refreshSidebar({ resort });
  renderDefaultStatus();
}

function dropPendingSession(sessionId: string): void {
  pendingSessions.delete(sessionId);
  sessionMap.delete(sessionId);
  for (const projList of [state.cachedProjects, state.cachedAllProjects]) {
    for (const proj of projList) {
      proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
    }
  }
  if (openSessions.has(sessionId)) destroySession(sessionId);
  // Dropping the row takes its terminal with it, so a header still naming that
  // pane would be pointing at nothing.
  if (state.gridViewActive) {
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  } else if (state.activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }
}

// Archiving a session is also how a row gets forgotten, so it has to stop the
// process first and only hide the row once nothing is running under it. The
// three call sites (a row, a slug group, a whole project) all come through here
// so none of them can drift back into hiding a row over a live PTY.
export async function archiveSessionRow(session: SessionRow, archived: number): Promise<boolean> {
  const sessionId = session.sessionId;
  if (archived) {
    // Stop unconditionally: state.activePtyIds can lag the real PTY state by up to
    // the idle poll interval (sessions started by the scheduler or another
    // window), and stopping a dead session is a no-op.
    const result = await window.api.stopSession(sessionId);
    if (result && result.ok === false) {
      // The record is still live, so hiding the row would orphan it.
      alert(`Could not stop this session: ${result.error || 'unknown error'}`);
      return false;
    }
    state.activePtyIds.delete(sessionId);
  }
  await window.api.archiveSession(sessionId, Boolean(archived));
  session.archived = archived;
  // A pending row has no .jsonl to resume from, so archiving it means forgetting
  // it — and leaving the pending entry behind would re-inject the row on the
  // next refresh with its own `archived: 0`.
  if (archived && pendingSessions.has(sessionId)) dropPendingSession(sessionId);
  return true;
}

// Sidebar rendering (slugId, projectLabel, buildSlugGroup, renderSessionList,
// rebindSidebarEvents, buildSessionItem, startRename) → sidebar.js


export async function launchNewSession(project: Project, sessionOptions?: LaunchOptions): Promise<void> {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: 'New session',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Track as pending (no .jsonl yet)
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data so it appears in sidebar immediately
  sessionMap.set(sessionId, session);
  for (const projList of [state.cachedProjects, state.cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions ?? undefined);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  showSession(sessionId);
  pollActiveSessions();
}

// Legacy alias
function openNewSession(project: Project) {
  return launchNewSession(project);
}

export async function showTerminalHeader(session: SessionRow): Promise<void> {
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);
  terminalHeaderName.textContent = displayName ?? '';
  terminalHeaderId.textContent = session.sessionId;
  terminalHeader.style.display = '';
  updateTerminalHeader();

  // Show active shell profile
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId === 'auto') {
      terminalHeaderShell.style.display = 'none';
    } else {
      const profiles = await window.api.getShellProfiles();
      const profile = profiles.find(p => p.id === profileId);
      terminalHeaderShell.textContent = profile ? profile.name : profileId;
      terminalHeaderShell.style.display = '';
    }
  } catch {
    terminalHeaderShell.style.display = 'none';
  }
}

// Terminal lifecycle (createTerminalEntry, destroySession, showSession, setupDragAndDrop) → terminal-manager.js

export async function openSession(session: SessionRow, customOptions?: LaunchOptions): Promise<void> {
  const { sessionId, projectPath } = session;

  // If already open, handle closed-session cleanup or just show it
  const existingEntry = openSessions.get(sessionId);
  if (existingEntry) {
    const entry = existingEntry;
    if (entry.closed) {
      destroySession(sessionId);
      if (session.type === 'terminal') {
        launchTerminalSession(projectFor(session.projectPath));
        return;
      }
    } else {
      showSession(sessionId);
      return;
    }
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process. Remote sessions ignore local launch
  // options — the main process reconnects from its stored session record.
  const resumeOptions = session.type === 'remote'
    ? { type: 'remote', remoteKind: session.remoteKind }
    : (customOptions || await resolveDefaultSessionOptions(projectFor(projectPath)));
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  showSession(sessionId);
  pollActiveSessions();
}

// Handle window resize
window.addEventListener('resize', () => {
  if (state.gridViewActive) {
    for (const entry of openSessions.values()) {
      fitAndScroll(entry);
    }
    return;
  }
  const active = state.activeSessionId ? openSessions.get(state.activeSessionId) : undefined;
  if (active) {
    safeFit(active);
  }
});

// --- Tab switching ---
document.querySelectorAll<HTMLElement>('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    if (!tabName || tabName === state.activeTab) return;
    state.activeTab = tabName;
    document.querySelectorAll<HTMLElement>('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

    // Clear search on tab switch
    searchInput.value = '';
    searchBar.classList.remove('has-query');
    state.searchMatchIds = null;
    state.searchMatchProjectPaths = null;

    // Hide all sidebar content areas
    sidebarContent.style.display = 'none';
    plansContent.style.display = 'none';
    statsContent.style.display = 'none';
    memoryContent.style.display = 'none';
    sessionFilters.style.display = 'none';
    searchBar.style.display = 'none';

    if (tabName === 'sessions') {
      sessionFilters.style.display = '';
      searchBar.style.display = '';
      searchInput.placeholder = 'Search sessions...';
      sidebarContent.style.display = '';
      // Restore terminal area
      hideAllViewers();
      if (state.gridViewActive) {
        // Grid is still set up — just re-show it and refit
        placeholder.style.display = 'none';
        terminalHeader.style.display = 'none';
        gridViewer.style.display = 'block';
        for (const entry of openSessions.values()) {
          if (!entry.closed) fitAndScroll(entry);
        }
      } else if (state.activeSessionId && openSessions.has(state.activeSessionId)) {
        showSession(state.activeSessionId);
      } else {
        placeholder.style.display = '';
      }
      // Catch up on changes that happened while on another tab
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
      }
    } else if (tabName === 'plans') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search plans...';
      plansContent.style.display = '';
      loadPlans();
    } else if (tabName === 'stats') {
      statsContent.style.display = '';
      // Immediately show stats viewer in main area
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      planViewer.style.display = 'none';
      memoryViewer.style.display = 'none';
      settingsViewer.style.display = 'none';
      statsViewer.style.display = 'flex';
      loadStats();
    } else if (tabName === 'memory') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search agent files...';
      memoryContent.style.display = '';
      loadMemories();
    }
  });
});

// Plans & viewer helpers → plans-memory-view.js


// Grid view → grid-view.js
// Initialize grid observers now that DOM refs are ready
initGridObservers();

// JSONL viewer (renderJsonlText, formatDuration, makeCollapsible, renderJsonlEntry, showJsonlViewer) → jsonl-viewer.js

// Stats view (loadStats, buildUsageSection, buildDailyBarChart, buildHeatmap, calculateStreak, buildStatsSummary) → stats-view.js

// Memory viewer → plans-memory-view.js


// Dialogs (resolveDefaultSessionOptions, forkSession, showNewSessionPopover,
// showNewSessionDialog, showResumeSessionDialog, showProjectPickerDialog,
// showAddProjectDialog, launchTerminalSession) → dialogs.js


// --- Sidebar toggle ---
{
  const sidebar = el('sidebar');
  const collapseBtn = el('sidebar-collapse-btn');
  const expandBtn = el('sidebar-expand-btn');

  collapseBtn.addEventListener('click', () => sidebar.classList.add('collapsed'));
  expandBtn.addEventListener('click', () => sidebar.classList.remove('collapsed'));
}

// --- Sidebar resize ---
{
  const sidebar = el('sidebar');
  const handle = el('sidebar-resize-handle');
  let dragging = false;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    const width = Math.min(600, Math.max(200, e.clientX));
    sidebar.style.width = width + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Refit active terminal
    const resized = state.activeSessionId ? openSessions.get(state.activeSessionId) : undefined;
    if (!state.gridViewActive && resized) {
      safeFit(resized);
    }
    // Save sidebar width to settings
    const width = parseInt(sidebar.style.width);
    if (width) {
      window.api.getSetting<GlobalSettings>('global').then(g => {
        const global: GlobalSettings = g || {};
        global.sidebarWidth = width;
        window.api.setSetting('global', global);
      });
    }
  });
}

// --- Grid view toggle button (next to resort button in sidebar filters) ---
{
  const gridToggleBtn = document.createElement('button');
  gridToggleBtn.id = 'grid-toggle-btn';
  gridToggleBtn.title = 'Session overview';
  gridToggleBtn.innerHTML = '<svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';
  gridToggleBtn.addEventListener('click', toggleGridView);
  // Insert next to the resort button
  resortBtn.parentElement?.insertBefore(gridToggleBtn, resortBtn);

  // Global keyboard shortcuts (covers non-terminal focus)
  // When a terminal is focused, xterm's customKeyEventHandler fires first and sets
  // e._handled to prevent the document listener from double-firing the same action.
  document.addEventListener('keydown', (e: KeyboardEvent & { _handled?: boolean }) => {
    if (e._handled) return;
    // Cmd/Ctrl+Shift+G → toggle grid view
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'g' && mod && e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleGridView();
      return;
    }
    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    handleSessionNavKey(e);
  });
}

// Warm up xterm.js renderer so first terminal open is fast
setTimeout(() => {
  const warmEl = document.createElement('div');
  warmEl.style.cssText = 'position:absolute;left:-9999px;width:400px;height:200px;';
  document.body.appendChild(warmEl);
  const warmTerm = new Terminal({ cols: 80, rows: 10 });
  const warmFit = new FitAddon();
  warmTerm.loadAddon(warmFit);
  warmTerm.open(warmEl);
  warmTerm.write(' ');
  requestAnimationFrame(() => {
    warmTerm.dispose();
    warmEl.remove();
  });
}, 100);


// --- Init: restore settings ---
(async () => {
  const global = await window.api.getSetting<GlobalSettings>('global');
  if (global) {
    if (global.sidebarWidth) {
      el('sidebar').style.width = global.sidebarWidth + 'px';
    }
    if (global.visibleSessionCount) {
      state.visibleSessionCount = Number(global.visibleSessionCount);
    }
    if (global.sessionMaxAgeDays) {
      state.sessionMaxAgeDays = Number(global.sessionMaxAgeDays);
    }
    const themeName = global.terminalTheme as string | undefined;
    if (themeName && themeName in TERMINAL_THEMES) {
      applyTerminalTheme(themeName);
    }
    // Applied rather than just assigned: session restore can open terminals before
    // this async read resolves, and those need the stored font too.
    applyTerminalFont({
      fontFamily: global.terminalFontFamily,
      fontSize: global.terminalFontSize,
      lineHeight: global.terminalLineHeight,
    });
  }
})();

loadProjects().then(() => {
  // Restore grid view preference before opening sessions so they enter grid mode
  if (localStorage.getItem('state.gridViewActive') === '1') {
    showGridView();
  }
  // Restore active session after reload. Remote sessions may need a fresh SSH
  // connection (auth prompts and all) — never start one without a click;
  // reattaching to a PTY that is still connected is fine.
  if (state.activeSessionId && !openSessions.has(state.activeSessionId)) {
    const session = sessionMap.get(state.activeSessionId);
    if (session && (session.type !== 'remote' || state.activePtyIds.has(session.sessionId))) {
      openSession(session);
    }
  }
});

// Live-reload sidebar when filesystem changes are detected
let projectsChangedTimer: ReturnType<typeof setTimeout> | null = null;
let projectsChangedWhileAway = false;
window.api.onProjectsChanged(() => {
  // Debounce to avoid rapid re-renders during bulk changes
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
  if (state.activeTab !== 'sessions') {
    projectsChangedWhileAway = true;
    return;
  }
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    loadProjects();
  }, 300);
});

// Status bar
let activityTimer: ReturnType<typeof setTimeout> | null = null;

function renderDefaultStatus() {
  const totalSessions = state.cachedAllProjects.reduce((n, p) => n + p.sessions.length, 0);
  const totalProjects = state.cachedAllProjects.length;
  const running = state.activePtyIds.size;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${totalSessions} sessions`);
  parts.push(`${totalProjects} projects`);
  statusBarInfo.textContent = parts.join(' \u00b7 ');
}

window.api.onStatusUpdate((text, type) => {
  if (activityTimer) clearTimeout(activityTimer);
  statusBarActivity.textContent = text;
  statusBarActivity.className = type === 'done' ? 'status-done' : '';
  if (!text || type === 'done') {
    activityTimer = setTimeout(() => {
      statusBarActivity.textContent = '';
      statusBarActivity.className = '';
    }, type === 'done' ? 3000 : 0);
  }
});

// --- Auto-update status + toast ---
const statusBarUpdater = el('status-bar-updater');
let updaterStatusTimer: ReturnType<typeof setTimeout> | null = null;
function setUpdaterStatus(text: string, duration?: number): void {
  if (updaterStatusTimer) clearTimeout(updaterStatusTimer);
  statusBarUpdater.textContent = text;
  if (duration) {
    updaterStatusTimer = setTimeout(() => { statusBarUpdater.textContent = ''; }, duration);
  }
}
const updaterHandler = (type: string, data: UpdaterEventData = {}) => {
  switch (type) {
    case 'checking':
      setUpdaterStatus('Checking for updates…');
      break;
    case 'update-available':
      setUpdaterStatus(`Downloading v${data.version}…`);
      break;
    case 'update-not-available':
      setUpdaterStatus('Up to date', 3000);
      break;
    case 'download-progress':
      setUpdaterStatus(`Updating… ${Math.round(data.percent ?? 0)}%`);
      break;
    case 'update-downloaded': {
      setUpdaterStatus(`v${data.version} ready — restart to update`);
      const dismissed = localStorage.getItem('update-dismissed');
      if (dismissed === data.version) return;
      const toast = el('update-toast');
      const msg = el('update-toast-msg');
      const notice = (data.releaseName && data.releaseName !== `v${data.version}` && data.releaseName !== data.version) ? `<span class="update-summary">${escapeHtml(data.releaseName)}</span>` : '';
      msg.innerHTML = `New Version Ready<br><span class="update-version">v${data.version}</span> (<a href="https://github.com/doctly/switchboard/releases" target="_blank" class="update-notes-link">release notes</a>)${notice}`;
      toast.classList.remove('hidden');
      el('update-restart-btn').onclick = () => window.api.updaterInstall();
      el('update-dismiss-btn').onclick = () => {
        toast.classList.add('hidden');
        localStorage.setItem('update-dismissed', data.version ?? '');
      };
      break;
    }
    case 'error':
      setUpdaterStatus('Update check failed', 5000);
      break;
  }
};
window.api.onUpdaterEvent(updaterHandler);

// --- Quota gauges in status bar ---
// One bar per limit window the usage API reports — a 5-hour session window, a
// weekly all-models window, and a weekly window per model. Which one bites
// first varies, and the 5-hour is usually the emptiest while resetting within
// the day, so showing a single window would read as "plenty left" while a
// weekly one is the one actually running out. Rows come from the API
// self-describing, so a newly launched model gets a bar without a code change.
const quotaGaugeEl = el('status-bar-quota');

// Full labels ("Week (all models)") are too long for a status bar; the tooltip
// carries them in full.
function shortQuotaLabel(row: UsageLimit): string {
  if (row.kind === 'session') return '5h';
  if (row.kind === 'weekly_all') return 'Week';
  return row.model || 'Week';
}

function buildQuotaBar(row: UsageLimit): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'quota-item';

  const label = document.createElement('span');
  label.className = 'quota-label';
  label.textContent = shortQuotaLabel(row);
  wrap.appendChild(label);

  const track = document.createElement('span');
  track.className = 'quota-track';
  const fill = document.createElement('span');
  const pct = row.percent;
  fill.className = 'quota-fill' + (pct >= 80 ? ' quota-high' : pct >= 60 ? ' quota-mid' : '');
  fill.style.width = Math.min(Math.max(pct, 1), 100) + '%';
  track.appendChild(fill);
  wrap.appendChild(track);

  const pctEl = document.createElement('span');
  pctEl.className = 'quota-pct';
  pctEl.textContent = pct + '%';
  wrap.appendChild(pctEl);

  wrap.title = `${row.label}: ${pct}%` + (row.reset ? ` \u2014 resets ${row.reset}` : '');
  return wrap;
}

async function refreshQuotaGauge() {
  try {
    const usage = await window.api.getUsage();
    // Prefer the API's self-describing rows; fall back to the flat 5-hour keys.
    const rows = Array.isArray(usage?.limits) && usage.limits.length
      ? usage.limits
      : (usage?.session !== undefined
        ? [{ kind: 'session', label: 'Current session', percent: usage.session, reset: usage.sessionReset }]
        : []);
    if (!rows.length) { quotaGaugeEl.style.display = 'none'; return; }

    quotaGaugeEl.replaceChildren(...rows.map(buildQuotaBar));
    quotaGaugeEl.style.display = '';
  } catch {}
}
refreshQuotaGauge();
setInterval(refreshQuotaGauge, 5 * 60 * 1000);
quotaGaugeEl.addEventListener('click', () => {
  document.querySelector<HTMLElement>('.sidebar-tab[data-tab="stats"]')?.click();
});

// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();
