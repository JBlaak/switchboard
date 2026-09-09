// --- Session Grid Overview ---
// No reparenting — terminals stay in #terminals. We wrap each terminal container
// with an in-place card overlay (header/footer) and switch #terminals to grid layout.
//
import { clearNotifications } from '../../state/activity-store';
import { confirmAndStopSession } from '../sessions/session-actions';
import { setActiveSession } from '../sessions/active-session';
import { updateRunningIndicators } from '../sessions/session-poller';
import { hideViewerPanels } from '../panel/viewers';
import { hideFoldStrips } from '../code/fold-strip';
import {
  gridViewer, gridViewerCount, placeholder, sidebarContent, terminalArea, terminalHeader,
  terminalsEl,
} from '../../lib/dom';
import { openSessions, sessionMap, view } from '../../state/session-store';
import { fitAndScroll, isMac, showSession } from '../terminal/terminal-manager';
import { cleanDisplayName } from '../../../domain/session/title';
import { shortProjectPath } from '../../../domain/project/project-path';
import { formatDate } from '../../lib/format';

/** Which way an arrow key moves the focused card. */
type GridDirection = 'left' | 'right' | 'up' | 'down';

/** sessionId → the card wrapper placed around its terminal container. */
export let gridCards = new Map<string, HTMLElement>();
let gridFocusedSessionId: string | null = null;

export function wrapInGridCard(sessionId: string): void {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  if (!session || !entry) return;

  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary) || sessionId;
  const shortProject = shortProjectPath(session.projectPath);

  // Create card wrapper
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.dataset.sessionId = sessionId;

  // Header
  const header = document.createElement('div');
  header.className = 'grid-card-header';
  const dot = document.createElement('span');
  dot.className = 'grid-card-dot';
  header.appendChild(dot);
  const name = document.createElement('span');
  name.className = 'grid-card-name';
  name.textContent = displayName;
  header.appendChild(name);
  const project = document.createElement('span');
  project.className = 'grid-card-project';
  project.textContent = shortProject;
  header.appendChild(project);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'grid-card-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';
  stopBtn.style.display = view.activePtyIds.has(sessionId) ? '' : 'none';
  stopBtn.onclick = (e: MouseEvent) => {
    e.stopPropagation();
    confirmAndStopSession(sessionId);
  };
  header.appendChild(stopBtn);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'grid-card-footer';
  const statusSpan = document.createElement('span');
  const timeSpan = document.createElement('span');
  timeSpan.textContent = formatDate(new Date(session.modified));
  footer.appendChild(statusSpan);
  footer.appendChild(timeSpan);

  // Build the card DOM
  card.appendChild(header);
  entry.element.classList.add('visible', 'grid-mode');
  card.appendChild(entry.element);
  card.appendChild(footer);

  // The sidebar list is flat, so the grid is too: cards sit in sidebar order
  // with no per-directory headings.
  terminalsEl.appendChild(card);

  // Click header or footer to focus
  header.addEventListener('mousedown', (e: MouseEvent) => {
    e.stopPropagation();
    focusGridCard(sessionId);
  });
  // Double-click header to switch to full terminal view
  header.addEventListener('dblclick', (e: MouseEvent) => {
    e.stopPropagation();
    gridFocusedSessionId = sessionId;
    toggleGridView();
  });
  footer.addEventListener('mousedown', (e: MouseEvent) => {
    e.stopPropagation();
    focusGridCard(sessionId);
  });

  // Clicking/focusing the terminal area also selects the card
  entry.element.addEventListener('focusin', () => {
    if (view.gridViewActive && gridFocusedSessionId !== sessionId) {
      focusGridCard(sessionId);
    }
  });

  gridCards.set(sessionId, card);
  // Set initial status from the single source of truth
  updateRunningIndicators();
}

function unwrapGridCards() {
  for (const [sid, card] of gridCards) {
    const entry = openSessions.get(sid);
    if (entry) {
      entry.element.classList.remove('grid-mode', 'visible');
      // Move terminal container back out of the card, before the card
      card.parentNode?.insertBefore(entry.element, card);
    }
    card.remove();
  }
  gridCards.clear();
}

export function focusGridCard(sessionId: string): void {
  gridFocusedSessionId = sessionId;
  setActiveSession(sessionId);
  clearNotifications(sessionId);
  // Update sidebar active highlight
  document.querySelectorAll<HTMLElement>('.session-item.active').forEach(el => el.classList.remove('active'));
  const sidebarItem = document.querySelector<HTMLElement>(`.session-item[data-session-id="${sessionId}"]`);
  if (sidebarItem) sidebarItem.classList.add('active');
  // Update visual focus
  document.querySelectorAll<HTMLElement>('.grid-card').forEach(c => c.classList.remove('focused'));
  const card = gridCards.get(sessionId);
  if (card) {
    card.classList.add('focused');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const entry = openSessions.get(sessionId);
  if (entry) entry.terminal.focus();
}

export function showGridView() {
  view.gridViewActive = true;
  localStorage.setItem('view.gridViewActive', '1');
  placeholder.style.display = 'none';
  terminalHeader.style.display = 'none';

  // Hide the panels but keep terminal-area visible: the grid rearranges what is
  // inside it. Asking the one owner of panel visibility rather than naming them
  // here, so a panel added later cannot be left showing behind the grid.
  hideViewerPanels();
  terminalArea.style.display = '';
  // And the flip's strips, for the same reason and from the same kind of owner:
  // they are inside the area the grid has just claimed, and a folded half is a
  // statement about one session.
  hideFoldStrips();

  // Switch #terminals to grid layout
  terminalsEl.classList.add('grid-layout');

  // Collect open (non-closed) session IDs
  const openSet = new Set();
  for (const [sid, entry] of openSessions) {
    if (!entry.closed) openSet.add(sid);
  }

  // Hide all terminals first, then wrap cards in sidebar order
  document.querySelectorAll<HTMLElement>('.terminal-container').forEach(el => el.classList.remove('visible'));
  const sessionIds: string[] = [];
  const sidebarItems = sidebarContent.querySelectorAll<HTMLElement>('.session-item[data-session-id]');
  for (const item of sidebarItems) {
    const sid = item.dataset.sessionId;
    if (!sid || !openSet.has(sid)) continue;
    wrapInGridCard(sid);
    sessionIds.push(sid);
  }

  // Show grid header bar with session count
  gridViewer.style.display = 'block';
  setGridCount(sessionIds.length);

  const btn = document.getElementById('grid-toggle-btn');
  if (btn) btn.classList.add('active');

  // Fit all terminals after layout resolves
  for (const sid of sessionIds) {
    const entry = openSessions.get(sid);
    if (entry) fitAndScroll(entry);
  }
  // Focus active or first (deferred so fitAndScroll's rAF runs first)
  requestAnimationFrame(() => {
    const toFocus = view.activeSessionId && sessionIds.includes(view.activeSessionId) ? view.activeSessionId : sessionIds[0];
    if (toFocus) focusGridCard(toFocus);
  });
}

function updateGridColumns() {
  if (!view.gridViewActive) return;
  const width = terminalsEl.clientWidth;
  const minCardWidth = 560;
  const gap = 14;
  const fitCols = Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
  const cardCount = terminalsEl.querySelectorAll<HTMLElement>('.grid-card').length;
  const cols = Math.max(1, Math.min(fitCols, cardCount || 1));
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

// initGridObservers is called from app.js after DOM refs are ready
export function initGridObservers() {
  new ResizeObserver(updateGridColumns).observe(terminalsEl);
  new MutationObserver(updateGridColumns).observe(terminalsEl, { childList: true });
}

function hideGridView() {
  view.gridViewActive = false;
  localStorage.setItem('view.gridViewActive', '0');
  unwrapGridCards();
  terminalsEl.classList.remove('grid-layout');
  terminalsEl.style.gridTemplateColumns = '';
  gridViewer.style.display = 'none';
  const btn = document.getElementById('grid-toggle-btn');
  if (btn) btn.classList.remove('active');
}

export function toggleGridView() {
  if (view.gridViewActive) {
    const restoreId = gridFocusedSessionId || view.activeSessionId;
    hideGridView();
    gridFocusedSessionId = null;
    if (restoreId && openSessions.has(restoreId)) {
      showSession(restoreId);
    } else {
      placeholder.style.display = '';
    }
  } else {
    terminalHeader.style.display = 'none';
    showGridView();
  }
}

// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow) ---

// Returns ordered list of open (non-closed) session IDs matching sidebar order.
function getOrderedOpenSessionIds() {
  const items = sidebarContent.querySelectorAll<HTMLElement>('.session-item[data-session-id]');
  const ids: string[] = [];
  for (const item of items) {
    const sid = item.dataset.sessionId;
    if (!sid) continue;
    const entry = openSessions.get(sid);
    if (entry && !entry.closed) ids.push(sid);
  }
  return ids;
}

function navigateSession(direction: -1 | 1): void {
  const ids = getOrderedOpenSessionIds();
  const current = view.gridViewActive ? gridFocusedSessionId : view.activeSessionId;
  const idx = current ? ids.indexOf(current) : -1;
  let next;
  if (idx === -1) {
    next = ids[0];
  } else {
    next = ids[(idx + direction + ids.length) % ids.length];
  }
  if (ids.length === 0 || !next) return;
  if (view.gridViewActive) {
    focusGridCard(next);
  } else {
    showSession(next);
  }
}

// Navigate the grid in 2D by visual position using bounding rects, so wrapping
// rows and varying card sizes don't break the math.
function navigateGrid(direction: GridDirection): void {
  if (!view.gridViewActive) return;
  const cards = [...terminalsEl.querySelectorAll<HTMLElement>('.grid-card')];
  if (cards.length === 0) return;
  const currentCard = gridCards.get(gridFocusedSessionId || view.activeSessionId || '');
  if (!currentCard || !cards.includes(currentCard)) {
    for (const [sid, card] of gridCards) {
      if (card === cards[0]) { focusGridCard(sid); return; }
    }
    return;
  }
  const cur = currentCard.getBoundingClientRect();
  const curCx = cur.left + cur.width / 2;
  const curCy = cur.top + cur.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const card of cards) {
    if (card === currentCard) continue;
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Filter by direction
    const dx = cx - curCx;
    const dy = cy - curCy;
    let valid = false;
    switch (direction) {
      case 'left':  valid = dx < -10; break;
      case 'right': valid = dx > 10; break;
      case 'up':    valid = dy < -10; break;
      case 'down':  valid = dy > 10; break;
    }
    if (!valid) continue;
    // For left/right prefer same row (small dy), for up/down prefer same column (small dx)
    let dist;
    if (direction === 'left' || direction === 'right') {
      dist = Math.abs(dy) * 3 + Math.abs(dx);
    } else {
      dist = Math.abs(dx) * 3 + Math.abs(dy);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = card;
    }
  }
  if (!best) return;
  for (const [sid, card] of gridCards) {
    if (card === best) { focusGridCard(sid); return; }
  }
}

// Returns true if the key combo is a session nav shortcut (used by xterm to block without acting)
export function isSessionNavKey(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) return true;
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return true;
  return false;
}

export function handleSessionNavKey(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;

  // Cmd+Shift+[ or Cmd+Shift+] — prev/next session
  // On macOS, Shift changes e.key to { / }, so check code for reliable matching
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    if (e.type === 'keydown') navigateSession(e.code === 'BracketLeft' ? -1 : 1);
    return true;
  }

  // Cmd+Arrow — in grid view: 2D grid navigation; in single view: left/right cycle sessions
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    if (e.type === 'keydown') {
      if (view.gridViewActive) {
        const dirMap: Record<string, GridDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        navigateGrid(dirMap[e.key]);
      } else {
        const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
        navigateSession(dir);
      }
    }
    return true;
  }

  return false;
}

/** The card count in the grid's header. */
export function setGridCount(count: number): void {
  gridViewerCount.textContent = count + ' session' + (count !== 1 ? 's' : '');
}

/** Re-read the count from the cards actually on screen. */
export function updateGridCount(): void {
  setGridCount(gridCards.size);
}
