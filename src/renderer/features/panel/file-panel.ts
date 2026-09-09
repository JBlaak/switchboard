/**
 * The file and diff side panel.
 *
 * A collapsible panel to the right of the terminal, showing what the CLI sends
 * over the IDE bridge. A file open delegates to the shared viewer panel; a diff
 * gets its own merge view, because it also has to offer accept and reject —
 * per-chunk, in unified mode.
 *
 * State is per session: two sessions can each have a diff waiting, and
 * switching between them must not show one session's edit under the other's
 * name.
 */
import { createMergeViewer, createUnifiedMergeViewer } from '../../lib/codemirror-setup';
import { el } from '../../lib/dom';
import { openSessions } from '../../state/session-store';
import { ViewerPanel } from '../panel/viewer-panel';
import type { DiffRequest as McpDiffPayload } from '../../../domain/ide/ide-request';
import { flashButtonText } from '../panel/viewer-toolbar';

// ── Per-Session State ───────────────────────────────────────────────

/**
 * The tab a session currently has open in the panel.
 *
 * A diff tab carries the MCP request it is answering — closing it without an
 * explicit accept/reject is what sends DIFF_REJECTED back to the CLI.
 */
export interface PanelTab {
  type: 'file' | 'diff';
  filePath?: string;
  diffId?: string;
  tabName?: string;
  /** True once the user has accepted or rejected, so close() stays silent. */
  resolved?: boolean;
  /** A MergeView (side-by-side, with `.a`/`.b`) or a plain unified EditorView. */
  editorView?: any;
  /** Which diff layout this tab was built with. */
  _diffMode?: string;
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
let filePanelContentEl: HTMLElement;  // container for ViewerPanel or diff content
let filePanelResizeHandle: HTMLElement;
let terminalSplitEl: HTMLElement;
let currentPanelSessionId: string | null = null;

// ViewerPanel instance for file-type tabs
let fpViewerPanel: ViewerPanel | null = null;

// Diff-specific DOM
let diffToolbarEl: HTMLElement;
let diffBodyEl: HTMLElement;
let diffActionsEl: HTMLElement;
export let diffToggleBtn: HTMLButtonElement;

const PANEL_WIDTH_KEY = 'filePanelWidth';
const DEFAULT_PANEL_WIDTH = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10) || 450;
const MIN_PANEL_WIDTH = 280;

const DIFF_MODE_KEY = 'filePanelDiffMode';
let diffMode = localStorage.getItem(DIFF_MODE_KEY) || 'side-by-side';

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

  // Content container — holds either ViewerPanel or diff UI
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

  // ── Diff-specific UI ──
  const diffContainer = document.createElement('div');
  diffContainer.id = 'file-panel-diff';
  diffContainer.style.display = 'none';
  filePanelContentEl.appendChild(diffContainer);

  // Diff toolbar
  diffToolbarEl = document.createElement('div');
  diffToolbarEl.className = 'viewer-toolbar';

  const diffInfo = document.createElement('div');
  diffInfo.className = 'viewer-toolbar-info';
  diffInfo.innerHTML = '<span class="viewer-toolbar-title" id="diff-title"></span><span class="viewer-toolbar-path" id="diff-path"></span>';
  diffToolbarEl.appendChild(diffInfo);

  const diffControls = document.createElement('div');
  diffControls.className = 'viewer-toolbar-controls';

  diffToggleBtn = document.createElement('button');
  diffToggleBtn.className = 'fp-toolbar-btn';
  diffToggleBtn.textContent = diffMode === 'inline' ? 'Side-by-Side' : 'Inline';
  diffToggleBtn.title = diffMode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';
  diffToggleBtn.addEventListener('click', handleDiffModeToggle);
  diffControls.appendChild(diffToggleBtn);

  const diffSaveBtn = document.createElement('button');
  diffSaveBtn.className = 'fp-toolbar-btn fp-save-btn fp-icon-btn';
  diffSaveBtn.title = 'Save changes';
  diffSaveBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M433.941 129.941l-83.882-83.882A48 48 0 0 0 316.118 32H48C21.49 32 0 53.49 0 80v352c0 26.51 21.49 48 48 48h352c26.51 0 48-21.49 48-48V163.882a48 48 0 0 0-14.059-33.941zM272 80v80H144V80h128zm122 352H54a6 6 0 0 1-6-6V86a6 6 0 0 1 6-6h42v104c0 13.255 10.745 24 24 24h176c13.255 0 24-10.745 24-24V83.882l78.243 78.243a6 6 0 0 1 1.757 4.243V426a6 6 0 0 1-6 6zM224 232c-48.523 0-88 39.477-88 88s39.477 88 88 88 88-39.477 88-88-39.477-88-88-88zm0 128c-22.056 0-40-17.944-40-40s17.944-40 40-40 40 17.944 40 40-17.944 40-40 40z"></path></svg>';
  diffSaveBtn.addEventListener('click', handleDiffSave);
  diffControls.appendChild(diffSaveBtn);

  const diffCloseBtn = document.createElement('button');
  diffCloseBtn.className = 'fp-toolbar-btn fp-close-btn fp-icon-btn';
  diffCloseBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>';
  diffCloseBtn.title = 'Close panel';
  diffCloseBtn.addEventListener('click', handleClose);
  diffControls.appendChild(diffCloseBtn);

  diffToolbarEl.appendChild(diffControls);
  diffContainer.appendChild(diffToolbarEl);

  diffBodyEl = document.createElement('div');
  diffBodyEl.id = 'file-panel-body';
  diffContainer.appendChild(diffBodyEl);

  diffActionsEl = document.createElement('div');
  diffActionsEl.id = 'file-panel-actions';
  diffActionsEl.style.display = 'none';
  diffContainer.appendChild(diffActionsEl);

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  wireIpcListeners();
  setupPanelResizeHandle();
  addMcpToggle();
}

// ── Handlers ────────────────────────────────────────────────────────

function handleClose(): void {
  if (!currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);
  const tab = state.currentTab;

  if (tab) {
    if (tab.type === 'diff' && !tab.resolved) {
      window.api.mcpDiffResponse(currentPanelSessionId, tab.diffId ?? '', 'reject', null);
    }
    if (tab.type === 'diff' && tab.editorView) {
      tab.editorView.destroy();
      tab.editorView = null;
    }
    if (tab.type === 'file') {
      fpViewerPanel?.destroy();
    }
    state.currentTab = null;
  }

  state.panelVisible = false;
  hidePanel();
}

async function handleDiffSave(): Promise<void> {
  const state = currentPanelSessionId ? getSessionState(currentPanelSessionId) : null;
  const tab = state?.currentTab;
  if (!tab || tab.type !== 'diff' || !tab.editorView || !tab.filePath) return;

  let content: string | undefined;
  if (tab._diffMode === 'inline') {
    content = tab.editorView.state.doc.toString();
  } else if (tab.editorView.b) {
    content = tab.editorView.b.state.doc.toString();
  }
  if (content == null) return;

  const result = await window.api.saveFileForPanel(tab.filePath, content);
  if (result.ok) {
    const btn = diffToolbarEl.querySelector<HTMLElement>('.fp-save-btn');
    if (btn) flashButtonText(btn, 'Saved!');
  }
}

function handleDiffModeToggle(): void {
  diffMode = diffMode === 'inline' ? 'side-by-side' : 'inline';
  localStorage.setItem(DIFF_MODE_KEY, diffMode);
  diffToggleBtn.textContent = diffMode === 'inline' ? 'Side-by-Side' : 'Inline';
  diffToggleBtn.title = diffMode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';

  if (currentPanelSessionId) {
    const state = getSessionState(currentPanelSessionId);
    const tab = state.currentTab;
    if (tab && tab.type === 'diff') {
      if (tab.editorView) { tab.editorView.destroy(); tab.editorView = null; }
      renderTabContent(currentPanelSessionId, tab);
    }
  }
}

// ── IPC Wiring ──────────────────────────────────────────────────────

function wireIpcListeners(): void {
  window.api.onMcpOpenDiff((sessionId, diffId, data) => {
    openDiffTab(sessionId, diffId, data);
  });

  window.api.onMcpOpenFile((sessionId, data) => {
    openFileTab(sessionId, { ...data });
  });

  window.api.onMcpCloseAllDiffs((sessionId) => {
    closeAllDiffs(sessionId);
  });

  window.api.onMcpCloseTab((sessionId, diffId) => {
    closeDiffByDiffId(sessionId, diffId);
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

function openDiffTab(sessionId: string, diffId: string, data: McpDiffPayload): void {
  const state = getSessionState(sessionId);

  // Destroy previous
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'diff',
    label: data.tabName || basename(data.oldFilePath),
    filePath: data.oldFilePath,
    diffId,
    oldContent: data.oldContent,
    newContent: data.newContent,
    resolved: false,
    editorView: null,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

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
  const tab = state.currentTab;
  if (!tab) return;
  if (tab.type === 'diff' && tab.editorView) {
    tab.editorView.destroy();
    tab.editorView = null;
    // Clear stale search/goto-line bar references
    if (diffBodyEl) {
      const host = diffBodyEl as HTMLElement & { _cmSearchBar?: unknown; _cmGotoLine?: unknown };
      delete host._cmSearchBar;
      delete host._cmGotoLine;
    }
  }
  if (tab.type === 'file') {
    fpViewerPanel?.destroy();
  }
}

export async function openFileInPanel(sessionId: string, filePath: string): Promise<void> {
  const result = await window.api.readFileForPanel(filePath);
  if (!result.ok) return;
  openFileTab(sessionId, { filePath, content: result.content ?? '' });
}

function closeAllDiffs(sessionId: string): void {
  const state = filePanelState.get(sessionId);
  if (!state) return;

  if (state.currentTab?.type === 'diff') {
    destroyCurrentTab(state);
    state.currentTab = null;
    state.panelVisible = false;
    if (currentPanelSessionId === sessionId) hidePanel();
  }
}

function closeDiffByDiffId(sessionId: string, diffId: string): void {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab) return;
  if (state.currentTab.type !== 'diff' || state.currentTab.diffId !== diffId) return;

  state.currentTab.resolved = true;
  destroyCurrentTab(state);
  state.currentTab = null;
  state.panelVisible = false;
  if (currentPanelSessionId === sessionId) hidePanel();
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
 * state and then act on it, which is what lets the coming `Talk | Split | Code`
 * control work the split without knowing a session id at all.
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
 * Not the same as the panel's own close button: that one destroys the tab and
 * rejects a diff the CLI is still waiting on. This only takes the space back, so
 * reopening shows the same tab — a layout control must not answer the CLI on the
 * user's behalf.
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

  renderTabContent(sessionId, state.currentTab);
}

function renderTabContent(sessionId: string, tab: PanelTab | null): void {
  // Both containers are created by initFilePanel().
  const vpContainer = el('file-panel-viewer');
  const diffContainer = el('file-panel-diff');

  if (!tab) {
    vpContainer.style.display = 'none';
    diffContainer.style.display = 'none';
    return;
  }

  if (tab.type === 'file') {
    // Use ViewerPanel
    diffContainer.style.display = 'none';
    vpContainer.style.display = 'flex';
    fpViewerPanel?.open(String(tab.label ?? ''), tab.filePath ?? '', String(tab.content ?? ''));
  } else {
    // Diff mode
    vpContainer.style.display = 'none';
    diffContainer.style.display = 'flex';
    renderDiffContent(sessionId, tab);
  }
}

function renderDiffContent(sessionId: string, tab: PanelTab): void {
  diffBodyEl.innerHTML = '';

  // Update diff toolbar info
  const titleEl = diffToolbarEl.querySelector<HTMLElement>('#diff-title');
  const pathEl = diffToolbarEl.querySelector<HTMLElement>('#diff-path');
  if (titleEl) titleEl.textContent = String(tab.label ?? '');
  if (pathEl) pathEl.textContent = tab.filePath || '';

  if (!tab.editorView) {
    if (diffMode === 'inline') {
      tab.editorView = createUnifiedMergeViewer(
        diffBodyEl, String(tab.oldContent ?? ''), String(tab.newContent ?? ''), tab.filePath,
      );
      tab._diffMode = 'inline';
    } else {
      tab.editorView = createMergeViewer(
        diffBodyEl, String(tab.oldContent ?? ''), String(tab.newContent ?? ''), tab.filePath,
      );
      tab._diffMode = 'side-by-side';
    }
    tab.editorView.dom.addEventListener('click', () => tab.editorView.dom.focus());
  } else {
    diffBodyEl.appendChild(tab.editorView.dom);
  }

  // Accept/reject buttons
  if (!tab.resolved) {
    diffActionsEl.style.display = 'flex';
    diffActionsEl.innerHTML = '';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'file-panel-accept-btn';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => handleDiffAction(sessionId, tab, 'accept'));

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'file-panel-reject-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => handleDiffAction(sessionId, tab, 'reject'));

    diffActionsEl.appendChild(acceptBtn);
    diffActionsEl.appendChild(rejectBtn);
  } else {
    diffActionsEl.style.display = 'none';
  }
}

// ── Diff Actions ────────────────────────────────────────────────────

function handleDiffAction(sessionId: string, tab: PanelTab, action: string): void {
  if (tab.resolved) return;
  tab.resolved = true;

  if (action === 'accept') {
    let editedContent: string | null = null;
    if (tab.editorView) {
      if (tab._diffMode === 'inline') {
        editedContent = tab.editorView.state.doc.toString();
      } else if (tab.editorView.b) {
        editedContent = tab.editorView.b.state.doc.toString();
      }
    }

    if (editedContent && editedContent !== tab.newContent) {
      window.api.mcpDiffResponse(sessionId, tab.diffId ?? '', 'accept-edited', editedContent);
    } else {
      window.api.mcpDiffResponse(sessionId, tab.diffId ?? '', 'accept', null);
    }
  } else {
    window.api.mcpDiffResponse(sessionId, tab.diffId ?? '', 'reject', null);
  }

  diffActionsEl.style.display = 'none';
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
