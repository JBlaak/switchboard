/**
 * The project picker's highlighted row, and what each row says beside its name.
 *
 * Focus stays in the filter the whole time, so the highlight is a number the
 * picker keeps rather than real DOM focus. Pure, so the rules run under the
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
