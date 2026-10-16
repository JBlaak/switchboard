/**
 * Driving the session list from the keyboard.
 *
 * Cmd+L takes focus out of the terminal and puts a cursor on the row on
 * screen. The arrows (or J and K) move it, Enter does what a click would, R or
 * F2 renames, E archives (a group header archives the whole group; Cmd+E, from
 * anywhere, archives the open session), A (or Cmd+A, from anywhere) starts a
 * new session, and Escape goes back to the terminal.
 *
 * Where the cursor can go is read from the list's layout (`state/list-cursor`):
 * rows, group headers and the "more" toggles all take part, in the order the
 * list renders them. The cursor itself is state, so it survives a redraw, and
 * if what it was on is gone the next arrow simply starts again from the top.
 *
 * The keys are heard on `#sidebar-content`, which is what holds the focus
 * while the cursor is out: the focus, and scrolling the cursor into view,
 * are the parts that stay with the DOM.
 */
import { flushSync } from 'react-dom';
import { sidebarContent } from '../../lib/dom';
import { getState } from '../../state/app-store';
import {
  cursorTargets, liveCursor, shownTargets, startTarget, stepTarget, targetAfterRemoval,
} from '../../state/list-cursor';
import { openSessions } from '../../state/session-store';
import { openDialog } from '../../ui/dialogs/actions';
import {
  expandSlugGroup, openRow, startRename, toggleOlder, toggleSlugGroup,
} from '../../ui/session-list/actions';
import { cursorElement, pressArchive, setListCursor } from '../../ui/session-list/cursor';
import type { CursorTarget } from '../../state/list-cursor';

export function isSidebarFocusKey(e: KeyboardEvent): boolean {
  if (e.altKey || e.code !== 'KeyL') return false;
  return e.metaKey && !e.shiftKey && !e.ctrlKey;
}

/**
 * Cmd+A opens the new-session picker.
 *
 * Except in a text field, where it stays Select All — the picker's own filter
 * among them.
 */
export function isSessionPickerKey(e: KeyboardEvent): boolean {
  return isCommandKey(e, 'KeyA');
}

/** Cmd+E archives the open session, with the same text-field exception. */
export function isArchiveSessionKey(e: KeyboardEvent): boolean {
  return isCommandKey(e, 'KeyE');
}

/** Cmd plus `code`, unless the key is going into a text field. */
function isCommandKey(e: KeyboardEvent, code: string): boolean {
  if (e.altKey || e.shiftKey || e.ctrlKey || !e.metaKey || e.code !== code) return false;
  const target = e.target as HTMLElement | null;
  if (!target || target.closest('.xterm')) return true;
  return !target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/**
 * Archive the session on screen, the way its row's archive button does.
 *
 * Through the button rather than around it, so the confetti and the slide-out
 * happen here too.
 */
export function archiveActiveSession(): void {
  const { activeSessionId } = getState().view;
  if (!activeSessionId) return;
  const row = targets().find(t => t.kind === 'row' && t.sessionId === activeSessionId);
  if (row) pressArchive(row.name);
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
  const state = getState();
  if (state.toolbar.sidebarCollapsed) return;
  const start = startTarget(state.sessionList, targets(), state.view.activeSessionId);
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
      activateCursor();
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
      openDialog({ kind: 'projectPicker' });
      return;
    case 'Escape':
      e.preventDefault();
      backToTerminal();
      return;
  }
}

/** What the list renders right now that the cursor could be on. */
function targets(): CursorTarget[] {
  const state = getState();
  return cursorTargets(state.sessionList, state.view.activePtyIds);
}

function currentCursor(): CursorTarget | null {
  return liveCursor(getState().sessionList, targets());
}

function step(direction: -1 | 1): void {
  const shown = shownTargets(targets());
  const next = stepTarget(shown, currentCursor()?.name ?? null, direction);
  if (next) moveCursorTo(next);
}

/** Enter: what clicking the target would do. */
function activateCursor(): void {
  const cursor = currentCursor();
  if (!cursor) return;
  switch (cursor.kind) {
    case 'row':
      openRow(cursor.name, cursor.sessionId, cursor.groupId);
      return;
    case 'header':
      toggleSlugGroup(cursor.groupId);
      return;
    case 'more':
      expandSlugGroup(cursor.groupId);
      return;
    case 'older':
      toggleOlder();
      return;
  }
}

function renameAtCursor(): void {
  const cursor = currentCursor();
  if (cursor?.kind !== 'row') return;
  const { name } = cursor;

  // Committed at once: the input focuses itself as it mounts, and the keys
  // that end the rename are listened for on it.
  flushSync(() => startRename(name));
  const input = document.activeElement;
  if (!input || input === sidebarContent || !sidebarContent.contains(input)) return;

  // Enter or Escape finishes the rename; the list keeps the keyboard after it.
  // The input losing focus has already cleared the cursor, so it goes back on.
  input.addEventListener('keydown', (e: Event) => {
    const { key } = e as KeyboardEvent;
    if (key !== 'Enter' && key !== 'Escape') return;
    setTimeout(() => {
      sidebarContent.focus({ preventScroll: true });
      if (targets().some(t => t.name === name)) moveCursorTo(name);
    });
  });
}

/**
 * Archive what is under the cursor by pressing its own archive button, so the
 * slide-out and confetti are the same as a click. The cursor moves on to the
 * next target before this one is gone.
 */
function archiveAtCursor(): void {
  const cursor = currentCursor();
  if (!cursor || (cursor.kind !== 'row' && cursor.kind !== 'header')) return;

  const before = shownTargets(targets());
  // Marks the row (or group) as leaving at once, so it drops out of `after`.
  if (!pressArchive(cursor.name)) return;

  const next = targetAfterRemoval(before, cursor.name, shownTargets(targets()));
  if (next) moveCursorTo(next);
  else clearCursor();
}

function backToTerminal(): void {
  clearCursor();
  const { activeSessionId } = getState().view;
  const open = activeSessionId ? openSessions.get(activeSessionId) : undefined;
  if (open) open.terminal.focus();
  else sidebarContent.blur();
}

function moveCursorTo(target: string): void {
  setListCursor(target);
  cursorElement(target)?.scrollIntoView({ block: 'nearest' });
}

function clearCursor(): void {
  setListCursor(null);
}
