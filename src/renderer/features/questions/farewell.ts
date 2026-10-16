/**
 * Patch seeing the answers off: a small Patch that pops up bottom right over
 * the terminal once they have gone to Claude, and bows out a few seconds later.
 *
 * Its own short-lived mount rather than the panel's Patch, because the panel
 * is on its way out as this comes in. Decoration only — not a button, hidden
 * from assistive tech — so it cannot take a click or a key meant for the
 * terminal it sits over.
 */
import { mountPatch } from '@jblaak/patch';
import { questionBeat } from '../../../domain/companion/question-beats';
import { timeOfDay } from '../../../domain/companion/patch';
import { patchArrive, patchLeave } from './question-motion';
import type { PatchSky } from '@jblaak/patch';

/** Patch waits for the sheet to have mostly dropped before popping up. */
const FAREWELL_DELAY_MS = 280;
/** How long Patch stays before bowing out. */
const FAREWELL_STAY_MS = 3200;

/** Farewells still on screen, each with its way out. */
const showing = new Set<() => void>();

/**
 * Send every farewell on its way now. Claude can ask again within a second of
 * an answer, and the farewell sits above the sheet, so a new set of questions
 * must not come up underneath it.
 */
export function dismissFarewells(): void {
  for (const leave of [...showing]) leave();
}

export function showFarewell(host: HTMLElement, sky: PatchSky | null): void {
  const stage = document.createElement('div');
  stage.className = 'qp-farewell';
  stage.setAttribute('aria-hidden', 'true');
  host.appendChild(stage);

  const patch = mountPatch(stage);
  patch.appear({ ...questionBeat({ kind: 'sent' }), time: timeOfDay(new Date().getHours()), sky });
  patchArrive(stage, FAREWELL_DELAY_MS);

  const leave = (): void => {
    if (!showing.delete(leave)) return;
    clearTimeout(timer);
    void patchLeave(stage).then(() => {
      patch.destroy();
      stage.remove();
    });
  };
  showing.add(leave);
  const timer = setTimeout(leave, FAREWELL_STAY_MS);
}
