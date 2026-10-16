/**
 * The keyboard cursor, as state, and the element it is on.
 *
 * The cursor is recorded by a name each target can be rendered from (see
 * `state/list-cursor`), and the `kbd-cursor` class follows from state. The
 * keyboard navigation (`features/sessions/sidebar-keyboard`) decides where it
 * goes from the layout alone; the element is only wanted for what has to be
 * done to the DOM itself — scrolling it into view, and pressing its archive
 * button so the slide-out and the confetti start from it.
 */
import { dispatch } from '../../state/app-store';
import { sidebarContent } from '../../lib/dom';

export { headerTarget } from '../../state/list-cursor';

/** Put the cursor on the target of this name, or take it away. */
export function setListCursor(target: string | null): void {
  dispatch({ type: 'listCursorMoved', target });
}

/**
 * The element a cursor name renders as: the element of that id, or for a
 * group's header, the header at the top of the group's element.
 */
export function cursorElement(target: string): HTMLElement | null {
  if (target.startsWith('header:')) {
    const group = document.getElementById(target.slice('header:'.length));
    return group?.querySelector<HTMLElement>(':scope > .slug-group-header') ?? null;
  }
  const el = document.getElementById(target);
  return el && sidebarContent.contains(el) ? el : null;
}

/**
 * Press the archive button of a row or a group's header, as a click would.
 * False when it has none (a plain terminal's row).
 */
export function pressArchive(target: string): boolean {
  const button = cursorElement(target)
    ?.querySelector<HTMLElement>('.session-archive-btn, .slug-group-archive-btn');
  button?.click();
  return !!button;
}
