/**
 * The keyboard cursor, as state.
 *
 * The keyboard navigation (`features/sessions/sidebar-keyboard`) still finds
 * its targets in the DOM and reads the cursor back off the `kbd-cursor` class.
 * What it can no longer do is put that class on an element itself: the list
 * renders its rows' classes from state, and a class written behind React's back
 * would be wiped by the row's next render. So the cursor is recorded here, by
 * a name each target can be rendered from, and the class follows.
 */
import { dispatch } from '../../state/app-store';

/**
 * The name of a cursor target: its element id, or `header:<group id>` for a
 * slug group's header, which has no id of its own.
 */
export function cursorTargetOf(el: HTMLElement): string | null {
  if (el.classList.contains('slug-group-header')) {
    const group = el.parentElement;
    return group?.id ? headerTarget(group.id) : null;
  }
  return el.id || null;
}

export function headerTarget(groupId: string): string {
  return 'header:' + groupId;
}

/** Put the cursor on `el`, or take it away. */
export function setListCursor(el: HTMLElement | null): void {
  dispatch({ type: 'listCursorMoved', target: el ? cursorTargetOf(el) : null });
}
