/**
 * The Projects modal's highlighted row, what each row says beside its name,
 * and what each key does.
 *
 * Focus stays in the filter the whole time, so the highlight is a number the
 * modal keeps rather than real DOM focus. Pure, so the rules run under the
 * node test runner without a DOM.
 */

/** Something that moves the highlight. */
export type SelectionEvent =
  /** An arrow key: one row down (1) or up (-1), wrapping at both ends. */
  | { type: 'stepped'; step: 1 | -1 }
  /** A new query reorders everything, so the highlight starts from the best match again. */
  | { type: 'queried' }
  /** The pointer is over a row: Enter opens what the mouse is on. */
  | { type: 'hovered'; index: number };

/** The highlighted row, kept within a list that may have shrunk under it. */
export function clampSelection(selected: number, count: number): number {
  return count === 0 ? 0 : Math.min(selected, count - 1);
}

/** The highlight after `event`, over a list of `count` rows. */
export function nextSelection(selected: number, count: number, event: SelectionEvent): number {
  switch (event.type) {
    case 'stepped': {
      if (count === 0) return 0;
      const current = clampSelection(selected, count);
      return (current + event.step + count) % count;
    }
    case 'queried':
      return 0;
    case 'hovered':
      return event.index;
  }
}

/** A row's count: how many of its sessions run, or else how many it has. */
export function sessionCountLabel(total: number, running: number): string {
  return running > 0 ? `${running} running` : `${total} session${total === 1 ? '' : 's'}`;
}

// ── The keys (F1, #171) ──

/**
 * Which part of the modal has the keys: the project list, one project's
 * plans, or the add step.
 */
export type PickerMode = 'projects' | 'plans' | 'add';

/**
 * What a key does. `swallow` takes the key and does nothing (a Tab that has
 * nowhere to go must not move focus out of the filter).
 */
export type PickerKeyAction =
  | 'up' | 'down' | 'open' | 'into-plans' | 'back-to-projects'
  | 'add-project' | 'row-menu' | 'complete-path' | 'swallow';

/** The key, and where the caret sits in the field, so ← and → still move it through typed text. */
export interface PickerKey {
  key: string;
  shiftKey: boolean;
  /** ⌘ is held. */
  metaKey?: boolean;
  /** The caret is at the start of the field with nothing selected (true when it is empty). */
  caretAtStart: boolean;
  /** The caret is at the end of the field with nothing selected (true when it is empty). */
  caretAtEnd: boolean;
}

/**
 * What a key does in the modal. Null leaves the key to the field.
 *
 * In the list: ↑/↓ move, ↵ starts a session, ⌘↵ adds a project, ⌘. opens the
 * highlighted row's menu, and → or Tab on a project that can have plans opens
 * them, except that Tab completes the folder while the search is a path
 * (`pathQuery`). In the plans: ← or Shift-Tab goes back. In the add step: ↵
 * adds, and ⌘[ or ← with the caret at the start goes back.
 */
export function pickerKeyAction(
  mode: PickerMode, key: PickerKey, canOpenPlans: boolean, pathQuery = false,
): PickerKeyAction | null {
  const meta = !!key.metaKey;
  if (mode === 'add') {
    if (meta && key.key === '[') return 'back-to-projects';
    if (key.key === 'Enter' && !meta) return 'open';
    if (key.key === 'ArrowLeft' && !meta && key.caretAtStart) return 'back-to-projects';
    return null;
  }
  if (meta && key.key === 'Enter') return mode === 'projects' ? 'add-project' : 'swallow';
  if (meta && key.key === '.') return mode === 'projects' ? 'row-menu' : 'swallow';
  switch (key.key) {
    case 'ArrowDown': return 'down';
    case 'ArrowUp': return 'up';
    case 'Enter': return 'open';
    case 'Tab':
      if (mode === 'projects' && !key.shiftKey && pathQuery) return 'complete-path';
      if (mode === 'projects' && !key.shiftKey && canOpenPlans) return 'into-plans';
      if (mode === 'plans' && key.shiftKey) return 'back-to-projects';
      return 'swallow';
    case 'ArrowRight':
      return mode === 'projects' && canOpenPlans && !pathQuery && key.caretAtEnd ? 'into-plans' : null;
    case 'ArrowLeft':
      return mode === 'plans' && key.caretAtStart ? 'back-to-projects' : null;
    default:
      return null;
  }
}

/** What a key does while a row's ⋯ menu is open. */
export type RowMenuKeyAction = 'up' | 'down' | 'choose' | 'close' | 'swallow';

/**
 * The open menu takes the arrows, ↵, Esc and ⌘. again (which closes it); Tab
 * is swallowed so focus stays put. Anything else is the filter's.
 */
export function rowMenuKeyAction(key: PickerKey): RowMenuKeyAction | null {
  if (key.metaKey) return key.key === '.' ? 'close' : null;
  switch (key.key) {
    case 'ArrowDown': return 'down';
    case 'ArrowUp': return 'up';
    case 'Enter': return 'choose';
    case 'Escape': return 'close';
    case 'Tab': return 'swallow';
    default: return null;
  }
}
