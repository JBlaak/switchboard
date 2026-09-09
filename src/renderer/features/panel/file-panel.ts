/**
 * The file side panel.
 *
 * A collapsible panel to the right of the terminal, showing the file the CLI
 * sends over the IDE bridge (`openFile`) or the one a `file://` link in the
 * terminal points at. Rendering is the shared viewer panel's; what this module
 * owns is the split itself — its width, its resize handle, and the fact that
 * the terminal has to be refitted whenever either changes.
 *
 * **Diffs are not here any more.** A session asking to make an edit is reviewed
 * in the code area (`features/code/review-view.ts`), which is where code is
 * read and where the whole-worktree diff lives. This panel used to hold that
 * too — a merge view, accept and reject buttons, and the answer back to a CLI
 * parked on the call — and the split between "a file the CLI opened" and "an
 * edit the CLI is asking for" is what is left of that.
 *
 * State is per session: two sessions can each have a file open, and switching
 * between them must not show one session's file under the other's name.
 */
import { el } from '../../lib/dom';
import { openSessions } from '../../state/session-store';
import { ViewerPanel } from '../panel/viewer-panel';

// ── Per-Session State ───────────────────────────────────────────────

/** The file a session currently has open in the panel. */
export interface PanelTab {
  type: 'file';
  filePath?: string;
  [key: string]: unknown;
}

export interface PanelSessionState {
  currentTab: PanelTab | null;
  panelVisible: boolean;
  mcpActive?: boolean;
  [key: string]: unknown;
}

const filePanelState = new Map<string, PanelSessionState>();

// ── DOM References ──────────────────────────────────────────────────
//
// All of these are created by initFilePanel() before anything else runs, so
// after init they are non-null; the `!` at each use site says so once.

let filePanelEl: HTMLElement;
let filePanelContentEl: HTMLElement;  // container for the ViewerPanel
let filePanelResizeHandle: HTMLElement;
let terminalSplitEl: HTMLElement;
let currentPanelSessionId: string | null = null;

// ViewerPanel instance for file-type tabs
let fpViewerPanel: ViewerPanel | null = null;

const PANEL_WIDTH_KEY = 'filePanelWidth';
const DEFAULT_PANEL_WIDTH = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10) || 450;
const MIN_PANEL_WIDTH = 280;

// ── Initialization ──────────────────────────────────────────────────

export function initFilePanel(): void {
  const terminalArea = document.getElementById('terminal-area');
  const terminalsEl = document.getElementById('terminals');
  if (!terminalArea || !terminalsEl) return;

  // Create the split container
  terminalSplitEl = document.createElement('div');
  terminalSplitEl.id = 'terminal-split';

  terminalArea.removeChild(terminalsEl);
  terminalSplitEl.appendChild(terminalsEl);

  // Create resize handle
  filePanelResizeHandle = document.createElement('div');
  filePanelResizeHandle.id = 'file-panel-resize-handle';
  terminalSplitEl.appendChild(filePanelResizeHandle);

  // Create the file panel
  filePanelEl = document.createElement('div');
  filePanelEl.id = 'file-panel';

  // Content container — holds the ViewerPanel
  filePanelContentEl = document.createElement('div');
  filePanelContentEl.id = 'file-panel-content';
  filePanelEl.appendChild(filePanelContentEl);

  // ── ViewerPanel for file-type tabs ──
  const vpContainer = document.createElement('div');
  vpContainer.id = 'file-panel-viewer';
  vpContainer.style.display = 'none';
  filePanelContentEl.appendChild(vpContainer);

  fpViewerPanel = new ViewerPanel(vpContainer, {
    language: 'auto',
    onSave: (filePath, content) => window.api.saveFileForPanel(filePath, content),
    onClose: handleClose,
  });

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  wireIpcListeners();
  setupPanelResizeHandle();
  addMcpToggle();
}

// ── Handlers ────────────────────────────────────────────────────────

/**
 * The panel's own close button: put the file away and take the space back.
 *
 * Nothing is owed to the CLI here any more. The one tab that could not be
 * closed silently was the diff — closing it rejected the edit a session was
 * waiting on — and that lives on the review surface now, where the only way to
 * answer is to answer.
 */
function handleClose(): void {
  if (!currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);

  if (state.currentTab) {
    fpViewerPanel?.destroy();
    state.currentTab = null;
  }

  state.panelVisible = false;
  hidePanel();
}

// ── IPC Wiring ──────────────────────────────────────────────────────

function wireIpcListeners(): void {
  window.api.onMcpOpenFile((sessionId, data) => {
    openFileTab(sessionId, { ...data });
  });
}

// ── Session State Helpers ───────────────────────────────────────────

function getSessionState(sessionId: string): PanelSessionState {
  if (!filePanelState.has(sessionId)) {
    filePanelState.set(sessionId, {
      currentTab: null,
      panelVisible: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
      mcpActive: false,
    });
  }
  return filePanelState.get(sessionId)!;
}

export function setSessionMcpActive(sessionId: string, active: boolean): void {
  const state = getSessionState(sessionId);
  state.mcpActive = active;
  if (currentPanelSessionId === sessionId) updateMcpIndicator();
}

export function rekeyFilePanelState(oldId: string, newId: string): void {
  const state = filePanelState.get(oldId);
  if (state) {
    filePanelState.delete(oldId);
    filePanelState.set(newId, state);
  }
}

// ── Tab Operations ──────────────────────────────────────────────────

function openFileTab(sessionId: string, data: { filePath: string; content: string; [key: string]: unknown }): void {
  const state = getSessionState(sessionId);

  // Destroy previous
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'file',
    label: basename(data.filePath),
    filePath: data.filePath,
    content: data.content,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function destroyCurrentTab(state: PanelSessionState): void {
  if (!state.currentTab) return;
  fpViewerPanel?.destroy();
}

export async function openFileInPanel(sessionId: string, filePath: string): Promise<void> {
  const result = await window.api.readFileForPanel(filePath);
  if (!result.ok) return;
  openFileTab(sessionId, { filePath, content: result.content ?? '' });
}

// ── Panel Show/Hide ─────────────────────────────────────────────────

function showPanel(state: PanelSessionState): void {
  if (!filePanelEl) return;
  filePanelEl.classList.add('open');
  filePanelEl.style.width = (state.panelWidth || DEFAULT_PANEL_WIDTH) + 'px';
  filePanelResizeHandle.style.display = 'block';
  refitActiveTerminal();
}

function hidePanel(): void {
  if (!filePanelEl) return;
  filePanelEl.classList.remove('open');
  filePanelEl.style.width = '0';
  filePanelResizeHandle.style.display = 'none';
  refitActiveTerminal();
}

/**
 * Open the split on whichever session the panel is currently showing.
 *
 * `showPanel`/`hidePanel` are only reachable through `switchPanel`, which is how
 * session activation moves the panel between sessions: it decides visibility
 * from the session's stored state, so a control that just wants the split open
 * would have to impersonate a session activation to get it. These two write that
 * state and then act on it, which is what lets the `Talk | Split | Code` control
 * work the split without knowing a session id at all.
 *
 * With no tab open the split is empty — the CLI has sent nothing to show yet.
 * That is deliberate rather than refused: the control asked for the space.
 */
export function openFilePanel(): void {
  if (!currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);
  state.panelVisible = true;
  showPanel(state);
  renderPanel(currentPanelSessionId);
}

/**
 * Collapse the split, keeping what is in it.
 *
 * Not the same as the panel's own close button: that one destroys the tab. This
 * only takes the space back, so reopening shows the same file.
 */
export function closeFilePanel(): void {
  if (!currentPanelSessionId) return;
  getSessionState(currentPanelSessionId).panelVisible = false;
  hidePanel();
}

export function switchPanel(sessionId: string | null): void {
  currentPanelSessionId = sessionId;
  updateMcpIndicator();

  if (!sessionId) {
    hidePanel();
    return;
  }

  const state = getSessionState(sessionId);

  if (state.panelVisible && state.currentTab) {
    showPanel(state);
    renderPanel(sessionId);
  } else {
    hidePanel();
  }
}

function updateMcpIndicator(): void {
  if (!mcpIndicatorEl) return;
  if (!currentPanelSessionId) {
    mcpIndicatorEl.style.display = 'none';
    return;
  }
  const state = filePanelState.get(currentPanelSessionId);
  mcpIndicatorEl.style.display = (state && state.mcpActive) ? '' : 'none';
}

// ── Panel Rendering ─────────────────────────────────────────────────

function renderPanel(sessionId: string): void {
  if (!filePanelEl || currentPanelSessionId !== sessionId) return;

  const state = getSessionState(sessionId);
  if (!state) return;

  renderTabContent(state.currentTab);
}

function renderTabContent(tab: PanelTab | null): void {
  // Created by initFilePanel().
  const vpContainer = el('file-panel-viewer');

  if (!tab) {
    vpContainer.style.display = 'none';
    return;
  }

  vpContainer.style.display = 'flex';
  fpViewerPanel?.open(String(tab.label ?? ''), tab.filePath ?? '', String(tab.content ?? ''));
}

// ── IDE Emulation Indicator ─────────────────────────────────────────

let mcpIndicatorEl: HTMLElement | null = null;

function addMcpToggle(): void {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  mcpIndicatorEl = document.createElement('span');
  mcpIndicatorEl.className = 'mcp-toggle enabled';
  mcpIndicatorEl.title = 'IDE Emulation is active. Go to Global Settings to disable.';
  mcpIndicatorEl.textContent = 'IDE Emulation';
  mcpIndicatorEl.style.display = 'none';

  const stopBtn = document.getElementById('terminal-stop-btn');
  if (stopBtn) {
    controls.insertBefore(mcpIndicatorEl, stopBtn);
  } else {
    controls.appendChild(mcpIndicatorEl);
  }
}

// ── Resize Handle ───────────────────────────────────────────────────

function setupPanelResizeHandle(): void {
  if (!filePanelResizeHandle) return;

  let startX = 0;
  let startWidth = 0;

  function onMouseDown(e: MouseEvent) {
    e.preventDefault();
    startX = e.clientX;
    startWidth = filePanelEl.offsetWidth;
    filePanelResizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e: MouseEvent) {
    const delta = startX - e.clientX;
    const newWidth = Math.max(MIN_PANEL_WIDTH, startWidth + delta);
    filePanelEl.style.width = newWidth + 'px';
  }

  function onMouseUp() {
    filePanelResizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    const w = filePanelEl.offsetWidth;
    localStorage.setItem(PANEL_WIDTH_KEY, String(w));
    if (currentPanelSessionId) {
      const state = getSessionState(currentPanelSessionId);
      state.panelWidth = w;
    }

    refitActiveTerminal();
  }

  filePanelResizeHandle.addEventListener('mousedown', onMouseDown);
}

// ── Terminal Refit ──────────────────────────────────────────────────

function refitActiveTerminal(): void {
  requestAnimationFrame(() => {
    if (typeof openSessions !== 'undefined' && currentPanelSessionId) {
      const entry = openSessions.get(currentPanelSessionId);
      if (entry && entry.fitAddon) {
        try { entry.fitAddon.fit(); } catch {}
      }
    }
  });
}

// ── Utility ─────────────────────────────────────────────────────────

function basename(filePath: string | null | undefined): string {
  if (!filePath) return 'untitled';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'untitled';
}
