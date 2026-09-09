/**
 * The window's own chrome: the sidebar's width, and refitting on resize.
 *
 * Terminals are the reason any of this needs code. xterm measures its grid in
 * pixels, so every change to the space it occupies has to be followed by a
 * refit — and a refit while the element is hidden measures nothing, which is
 * why the tab router does its own.
 */
import { openSessions, view } from '../state/session-store';
import { el } from '../lib/dom';
import { fitAndScroll, safeFit } from '../features/terminal/terminal-manager';

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 600;

export function installLayout(): void {
  installSidebarToggle();
  installSidebarResize();
  installWindowResize();
}

function installSidebarToggle(): void {
  const sidebar = el('sidebar');
  el('sidebar-collapse-btn').addEventListener('click', () => sidebar.classList.add('collapsed'));
  el('sidebar-expand-btn').addEventListener('click', () => sidebar.classList.remove('collapsed'));
}

/**
 * Dragging the sidebar's edge.
 *
 * The move and release listeners are on `window`, not the handle: a fast drag
 * leaves the pointer behind, and a handle-scoped listener would drop it. The
 * width is persisted on release rather than during the drag, which would write
 * a setting per frame.
 */
function installSidebarResize(): void {
  const sidebar = el('sidebar');
  const handle = el('sidebar-resize-handle');
  let dragging = false;

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    // Otherwise the drag selects the text either side of the handle.
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    const width = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, e.clientX));
    sidebar.style.width = width + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    const active = view.activeSessionId ? openSessions.get(view.activeSessionId) : undefined;
    if (!view.gridViewActive && active) safeFit(active);

    const width = parseInt(sidebar.style.width, 10);
    if (width) void persistSidebarWidth(width);
  });
}

async function persistSidebarWidth(width: number): Promise<void> {
  const global = (await window.api.getSetting<Record<string, unknown>>('global')) || {};
  global.sidebarWidth = width;
  await window.api.setSetting('global', global);
}

/** Every terminal in the grid needs refitting; only the visible one otherwise. */
function installWindowResize(): void {
  window.addEventListener('resize', () => {
    if (view.gridViewActive) {
      for (const entry of openSessions.values()) fitAndScroll(entry);
      return;
    }
    const active = view.activeSessionId ? openSessions.get(view.activeSessionId) : undefined;
    if (active) safeFit(active);
  });
}
