/**
 * Rows glide to their new place when a redraw reorders the list (the reflow
 * from BlaakTasks, `lib/motion/reflow`).
 *
 * A FLIP needs the "before" taken before React commits the new order, and the
 * "after" played straight after. The before is taken from a store listener:
 * a redraw is a `sessionListBuilt` event, its listeners run inside the
 * dispatch, and React only commits the re-render that event schedules after
 * the dispatch has returned — so the DOM a listener measures is still the old
 * one. The after is a layout effect on the redraw count.
 *
 * Only top-level entries take part: a session inside a slug group rides along
 * on its group's transform, and moving it as well would move it twice. Rows
 * keep their elements across redraws (they are keyed by their local key), so
 * one caught mid-glide keeps its spring and heads for its newest place.
 */
import { useLayoutEffect, useRef } from 'react';
import { store } from '../../state/app-store';
import { play, snapshot } from '../../lib/motion/reflow';
import { redrawGlides } from '../../state/list-reflow';
import type { Snapshot } from '../../lib/motion/reflow';

/** The list's top-level entries: rows, slug groups, section labels and the "older" toggle — never what sits inside a group. */
const REFLOW_SELECTOR = '.session-list > [id], .sessions-older > [id]';

export function useReflow(container: HTMLElement, revision: number): void {
  const before = useRef<Snapshot | null>(null);

  useLayoutEffect(() => store.subscribe((state, previous) => {
    if (state.sessionList.revision === previous.sessionList.revision) return;
    const animate = redrawGlides(previous, state);
    // Two redraws before one commit: the first snapshot is still the DOM on screen.
    if (!animate) before.current = null;
    else before.current ??= snapshot(container, REFLOW_SELECTOR);
  }), [container]);

  useLayoutEffect(() => {
    const taken = before.current;
    before.current = null;
    if (taken) play(taken);
  }, [revision]);
}
