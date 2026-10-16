/**
 * Patch seeing the answers off: a small Patch that pops up bottom right over
 * the terminal once they have gone to Claude, and bows out a few seconds later.
 *
 * Its own short-lived mount rather than the panel's Patch, because the panel
 * is on its way out as this comes in. Decoration only — not a button, hidden
 * from assistive tech — so it cannot take a click or a key meant for the
 * terminal it sits over.
 *
 * Patch is the package's imperative handle, mounted into the stage from an
 * effect. The stay is a presentational timer of the farewell's own; it is
 * cut short by `leaving`, which the panel sets when a new set comes up,
 * since the farewell sits above the sheet and must not hide it.
 */
import { useEffect, useRef } from 'react';
import { mountPatch } from '@jblaak/patch';
import { questionBeat } from '../../../domain/companion/question-beats';
import { timeOfDay } from '../../../domain/companion/patch';
import { patchArrive, patchLeave } from '../../features/questions/question-motion';
import { questionSky } from './actions';
import type { JSX } from 'react';

/** Patch waits for the sheet to have mostly dropped before popping up. */
const FAREWELL_DELAY_MS = 280;
/** How long Patch stays before bowing out. */
const FAREWELL_STAY_MS = 3200;

export interface FarewellProps {
  /** Bow out now. */
  leaving: boolean;
  /** The stay is over; the parent should set `leaving`. */
  onStayed(): void;
  /** The bow is done; the parent can drop this farewell. */
  onGone(): void;
}

export function Farewell({ leaving, onStayed, onGone }: FarewellProps): JSX.Element {
  const stage = useRef<HTMLDivElement>(null);
  const hooks = useRef({ onStayed, onGone });
  hooks.current = { onStayed, onGone };

  useEffect(() => {
    const el = stage.current!;
    const patch = mountPatch(el);
    patch.appear({ ...questionBeat({ kind: 'sent' }), time: timeOfDay(new Date().getHours()), sky: questionSky() });
    patchArrive(el, FAREWELL_DELAY_MS);
    const timer = setTimeout(() => hooks.current.onStayed(), FAREWELL_STAY_MS);
    return () => {
      clearTimeout(timer);
      patch.destroy();
    };
  }, []);

  useEffect(() => {
    if (!leaving) return;
    let live = true;
    void patchLeave(stage.current!).then(() => { if (live) hooks.current.onGone(); });
    return () => { live = false; };
  }, [leaving]);

  return <div ref={stage} className="qp-farewell" aria-hidden="true" />;
}
