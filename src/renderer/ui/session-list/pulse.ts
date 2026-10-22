/**
 * A row that pulses once (#173): a session started without taking the main
 * area (from the project page) says it has arrived in the sidebar.
 *
 * A CSS animation on a data attribute rather than `lib/motion`: its springs
 * scale and move, and a whole row bumping in scale reads as a jolt, not a
 * nod. The attribute is not one React renders, so a redraw of the row leaves
 * it alone; it comes off when the animation ends. Under reduced motion there
 * is no pulse.
 */
import { sidebarContent } from '../../lib/dom';
import { reducedMotion } from '../../lib/motion/spring';

/** The keyframes' name in `_sidebar.scss`. */
const PULSE = 'session-row-pulse';

/** How many frames to wait for the row to be drawn: a new session's row lands a redraw later. */
const FRAMES_TO_WAIT = 60;

export function pulseSessionRow(sessionId: string): void {
  if (reducedMotion()) return;
  let frames = 0;
  const find = (): void => {
    const row = sidebarContent.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionId)}"]`);
    if (!row) {
      if (++frames < FRAMES_TO_WAIT) requestAnimationFrame(find);
      return;
    }
    row.removeAttribute('data-pulse');
    // A pulse already running starts over, rather than being ignored.
    void row.offsetWidth;
    row.setAttribute('data-pulse', '');
    // The pulse's own end, not another animation's bubbling up from the row.
    const done = (e: AnimationEvent): void => {
      if (e.animationName !== PULSE) return;
      row.removeAttribute('data-pulse');
      row.removeEventListener('animationend', done);
    };
    row.addEventListener('animationend', done);
  };
  requestAnimationFrame(find);
}
