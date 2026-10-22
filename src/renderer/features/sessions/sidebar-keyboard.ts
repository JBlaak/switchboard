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
import { listCursorKey } from '../../lib/shortcut-keys';
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
import { highlightedSession } from '../../state/main-area-slice';
import type { CursorTarget } from '../../state/list-cursor';

export { isArchiveSessionKey, isSessionPickerKey, isSidebarFocusKey } from '../../lib/shortcut-keys';

/**
 * Archive the session on screen, the way its row's archive button does.
 *
 * Through the button rather than around it, so the confetti and the slide-out
 * happen here too.
 */
export function archiveActiveSession(): void {
  const onScreen = highlightedSession(getState().mainArea);
  if (!onScreen) return;
  const row = targets().find(t => t.kind === 'row' && t.sessionId === onScreen);
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
  const start = startTarget(state.sessionList, targets(), highlightedSession(state.mainArea));
  if (!start) return;
  sidebarContent.focus({ preventScroll: true });
  moveCursorTo(start);
}

function onKeyDown(e: KeyboardEvent): void {
  // Keys typed into a rename input are the input's own.
  if (e.target !== sidebarContent) return;

  const key = listCursorKey(e);
  if (!key) return;
  e.preventDefault();
  switch (key) {
    case 'down':
    case 'up':
      step(key === 'down' ? 1 : -1);
      return;
    case 'activate':
      activateCursor();
      return;
    case 'rename':
      renameAtCursor();
      return;
    case 'archive':
      archiveAtCursor();
      return;
    case 'newSession':
      openDialog({ kind: 'projectPicker' });
      return;
    case 'leave':
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
  const onScreen = highlightedSession(getState().mainArea);
  const open = onScreen ? openSessions.get(onScreen) : undefined;
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
