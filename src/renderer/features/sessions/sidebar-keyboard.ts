/**
 * Driving the session list from the keyboard.
 *
 * Cmd+L takes focus out of the terminal and puts a cursor on the row on
 * screen. The arrows (or J and K) move it, Enter does what a click would, R or
 * F2 renames, E archives (a group header archives the whole group), A starts a
 * new session, and Escape goes back to the terminal.
 *
 * The cursor is a class on the element rather than a remembered id: rows,
 * group headers and the "more" toggles all take part, and only rows have ids.
 * The morph carries the class across a redraw (see `sidebar-render`), and if
 * the element is gone the next arrow simply starts again from the active row.
 */
import { sidebarContent } from '../../lib/dom';
import { openSessions, sessionMap, view } from '../../state/session-store';
import { showProjectPickerDialog } from '../dialogs/project-picker-dialog';
import { startRename } from './session-rename';

export const CURSOR_CLASS = 'kbd-cursor';

/** Everything the cursor can land on — each one acts on click. */
const NAVIGABLE = '.session-item, .slug-group-header, .slug-group-more, .sessions-more-toggle';

export function isSidebarFocusKey(e: KeyboardEvent): boolean {
  if (e.altKey || e.code !== 'KeyL') return false;
  return e.metaKey && !e.shiftKey && !e.ctrlKey;
}

export function installSidebarKeyboard(): void {
  // Focusable from script only: tabbing should not stop on the whole list.
  sidebarContent.tabIndex = -1;
  sidebarContent.addEventListener('keydown', onKeyDown);
  sidebarContent.addEventListener('focusout', (e: FocusEvent) => {
    // A rename input inside the list keeps the cursor; anywhere else ends it.
    if (sidebarContent.contains(e.relatedTarget as Node | null)) return;
    clearCursor();
  });
}

/** Whether the list itself holds focus — the redraw must not hand it back to the terminal. */
export function isSidebarFocused(): boolean {
  return document.activeElement === sidebarContent;
}

export function focusSidebar(): void {
  if (document.getElementById('sidebar')?.classList.contains('collapsed')) return;
  const start = currentCursor()
    ?? sidebarContent.querySelector<HTMLElement>('.session-item.active')
    ?? navigableItems()[0];
  if (!start) return;
  sidebarContent.focus({ preventScroll: true });
  moveCursorTo(start);
}

function onKeyDown(e: KeyboardEvent): void {
  // Keys typed into a rename input are the input's own.
  if (e.target !== sidebarContent) return;

  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      e.preventDefault();
      step(e.key === 'ArrowDown' ? 1 : -1);
      return;
    case 'j':
    case 'k':
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      step(e.key === 'j' ? 1 : -1);
      return;
    case 'Enter':
      e.preventDefault();
      currentCursor()?.click();
      return;
    case 'r':
    case 'F2':
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      renameAtCursor();
      return;
    case 'e':
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      archiveAtCursor();
      return;
    case 'a':
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      showProjectPickerDialog();
      return;
    case 'Escape':
      e.preventDefault();
      backToTerminal();
      return;
  }
}

function step(direction: -1 | 1): void {
  const items = navigableItems();
  if (!items.length) return;
  const cursor = currentCursor();
  const at = cursor ? items.indexOf(cursor) : -1;
  const next = at === -1
    ? items[0]
    : items[Math.min(items.length - 1, Math.max(0, at + direction))];
  moveCursorTo(next);
}

function renameAtCursor(): void {
  const item = currentCursor();
  if (!item?.classList.contains('session-item')) return;
  const session = sessionMap.get(item.dataset.sessionId ?? '');
  const summary = item.querySelector<HTMLElement>('.session-summary');
  if (!session || !summary) return;

  startRename(summary, session);
  // Enter or Escape finishes the rename; the list keeps the keyboard after it.
  // The input losing focus has already cleared the cursor, so it goes back on.
  item.querySelector('.session-rename-input')?.addEventListener('keydown', (e: Event) => {
    const { key } = e as KeyboardEvent;
    if (key !== 'Enter' && key !== 'Escape') return;
    setTimeout(() => {
      sidebarContent.focus({ preventScroll: true });
      if (item.isConnected) moveCursorTo(item);
    });
  });
}

/**
 * Archive what is under the cursor by pressing its own archive button, so the
 * slide-out and confetti are the same as a click. The cursor moves on to the
 * next row before this one is gone.
 */
function archiveAtCursor(): void {
  const cursor = currentCursor();
  const button = cursor?.querySelector<HTMLElement>('.session-archive-btn, .slug-group-archive-btn');
  if (!cursor || !button) return;

  const before = navigableItems();
  const at = before.indexOf(cursor);
  button.click();

  // The leaving row (and, for a group, its rows) has dropped out of the list.
  const remaining = new Set(navigableItems());
  const next = before.slice(at + 1).find(el => remaining.has(el))
    ?? before.slice(0, at).reverse().find(el => remaining.has(el));
  if (next) moveCursorTo(next);
  else clearCursor();
}

function backToTerminal(): void {
  clearCursor();
  const open = view.activeSessionId ? openSessions.get(view.activeSessionId) : undefined;
  if (open) open.terminal.focus();
  else sidebarContent.blur();
}

/** Visible targets, in on-screen order: rows in a collapsed group or a hidden "older" list are skipped. */
function navigableItems(): HTMLElement[] {
  return [...sidebarContent.querySelectorAll<HTMLElement>(NAVIGABLE)]
    .filter(el => el.offsetParent !== null && !el.closest('[data-leaving]'));
}

function currentCursor(): HTMLElement | null {
  return sidebarContent.querySelector<HTMLElement>('.' + CURSOR_CLASS);
}

function moveCursorTo(el: HTMLElement): void {
  clearCursor();
  el.classList.add(CURSOR_CLASS);
  el.scrollIntoView({ block: 'nearest' });
}

function clearCursor(): void {
  sidebarContent.querySelectorAll('.' + CURSOR_CLASS).forEach(el => el.classList.remove(CURSOR_CLASS));
}
