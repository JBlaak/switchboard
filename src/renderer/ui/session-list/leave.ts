/**
 * A row (or a slug group) sliding out, the way BlaakTasks completes a task.
 *
 * The confetti gets a beat on its own, the row slides aside and dims, the list
 * closes the gap, and only then does the real work happen — so the row never
 * vanishes before you see it go. If the work fails the row comes back.
 *
 * The motion is imperative, on the element itself, through `lib/motion`; the
 * fact that the row is leaving is state (`rowLeaving`), which is what renders
 * its `data-leaving` and makes it ignore clicks meanwhile. React leaves the
 * inline transform, opacity and height alone, since no component sets them,
 * so a redraw mid-exit does not snap the row back.
 */
import { flushSync } from 'react-dom';
import { dispatch, getState } from '../../state/app-store';
import { celebrate } from '../../lib/motion/celebrate';
import { collapse, uncollapse } from '../../lib/motion/reflow';
import { motion, reducedMotion } from '../../lib/motion/spring';
import { sidebarContent } from '../../lib/dom';

/** The slide starts after the confetti has had a beat of its own. */
const SLIDE_AT_MS = 260;
/** Then the gap closes. */
const COLLAPSE_AT_MS = 600;
/** No slide or collapse under reduced motion, but still a pause, so the change reads as one. */
const REDUCED_PAUSE_MS = 450;

/** Whether this element id, or the group it sits in, is on its way out. */
export function isLeaving(id: string, groupId?: string): boolean {
  const { leaving } = getState().sessionList;
  return !!leaving[id] || (!!groupId && !!leaving[groupId]);
}

/** Confetti from the middle of the control that was clicked. */
export function celebrateFrom(el: Element): void {
  const r = el.getBoundingClientRect();
  celebrate(r.left + r.width / 2, r.top + r.height / 2);
}

/**
 * Confetti for a session archived from elsewhere — by itself, through its
 * `archive_session` tool, or from a phone — as a click on its archive button
 * would throw it: from the button, or from the row while the button is
 * hidden. Nothing when the row isn't in the list.
 */
export function celebrateArchivedRow(sessionId: string): void {
  const row = sidebarContent.querySelector<HTMLElement>(`.session-item[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!row || row.dataset.leaving !== undefined) return;
  const button = row.querySelector<HTMLElement>('.session-archive-btn');
  celebrateFrom(button && button.getBoundingClientRect().width > 0 ? button : row);
}

/**
 * Slide `el` (the element `id` renders) out, then run `act`.
 *
 * The leaving mark is committed at once rather than on the next render: the
 * keyboard's archive steps the cursor past the leaving row straight after
 * pressing its button, and finds it by `data-leaving`.
 */
export function leave(el: HTMLElement, id: string, act: () => Promise<boolean>): void {
  flushSync(() => dispatch({ type: 'rowLeaving', id, leaving: true }));
  const run = (): void => {
    act().catch(() => false).then(ok => {
      if (!ok) comeBack(el, id);
    });
  };

  if (reducedMotion()) {
    setTimeout(run, REDUCED_PAUSE_MS);
    return;
  }
  setTimeout(() => {
    const m = motion(el);
    m.fade = true;
    m.x.to(26);
    m.o.to(0.45);
  }, SLIDE_AT_MS);
  setTimeout(() => collapse(el, run), COLLAPSE_AT_MS);
}

function comeBack(el: HTMLElement, id: string): void {
  if (el.isConnected) uncollapse(el);
  dispatch({ type: 'rowLeaving', id, leaving: false });
}
