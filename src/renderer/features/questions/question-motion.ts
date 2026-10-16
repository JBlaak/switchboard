/**
 * The question panel's motion, from the approved motion spec.
 *
 * Two curves: ease-out for things that slide, a spring-shaped overshoot for
 * Patch and anything that pops. Exits are always shorter than entrances.
 *
 * The moves that replay on every question (the swap, the option stagger, the
 * check popping) go through the Web Animations API rather than CSS classes:
 * `animate()` starts from the first frame each time it is called, where a
 * class would have to be removed and re-added around a forced reflow. The
 * sheet and the terminal behind it are CSS transitions in _questions.scss,
 * because they only ever go between two states.
 *
 * With reduced motion nothing travels; things only fade.
 */
import { reducedMotion } from '../../lib/motion/spring';

export const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
export const SPRING = 'cubic-bezier(.34,1.56,.64,1)';
export const EASE_IN = 'ease-in';

/** The question leaving. Keys are held for exactly this long. */
export const QUESTION_OUT_MS = 140;
export const QUESTION_IN_MS = 260;
export const OPTION_STAGGER_MS = 35;
/** The first option trails the question block by this much. */
const OPTION_LEAD_MS = 60;
/** On a fresh showing, the question waits for the sheet to be mostly up. */
export const SHEET_SETTLE_MS = 160;
const PATCH_ARRIVE_MS = 620;
const PATCH_ARRIVE_DELAY_MS = 120;
const CHECK_POP_MS = 220;

export type Direction = 'fwd' | 'back';

/** Stop whatever is running on these, so a new animation starts clean. */
function cancel(...els: Element[]): void {
  for (const el of els) for (const a of el.getAnimations()) a.cancel();
}

/** End whatever is running on an element, leaving it at rest. */
export function settle(el: HTMLElement): void {
  cancel(el);
}

/** The question moves toward where you are going and fades. Resolves when it is gone. */
export function questionOut(block: HTMLElement, dir: Direction): Promise<void> {
  cancel(block);
  const to = reducedMotion()
    ? { opacity: 0 }
    : { opacity: 0, transform: `translateX(${dir === 'fwd' ? -16 : 16}px)` };
  const anim = block.animate([{ opacity: 1, transform: 'none' }, to], {
    duration: QUESTION_OUT_MS, easing: EASE_IN, fill: 'forwards',
  });
  return anim.finished.then(() => undefined, () => undefined);
}

/**
 * The new question comes in from the other side, its options rising one after
 * another. `delay` holds the whole entrance, for a sheet still rising.
 */
export function questionIn(block: HTMLElement, rows: HTMLElement[], dir: Direction, delay = 0): void {
  cancel(block, ...rows);
  const reduced = reducedMotion();
  const from = reduced
    ? { opacity: 0 }
    : { opacity: 0, transform: `translateX(${dir === 'fwd' ? 24 : -24}px)` };
  block.animate([from, { opacity: 1, transform: 'none' }], {
    duration: QUESTION_IN_MS, easing: EASE_OUT, delay, fill: 'backwards',
  });
  if (reduced) return;
  rows.forEach((row, i) => {
    row.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], {
      duration: QUESTION_IN_MS,
      easing: EASE_OUT,
      delay: delay + OPTION_LEAD_MS + i * OPTION_STAGGER_MS,
      fill: 'backwards',
    });
  });
}

/** A check or a radio dot popping past full size as it is chosen. */
export function popMark(mark: HTMLElement): void {
  if (reducedMotion()) return;
  cancel(mark);
  mark.animate(
    [{ transform: 'scale(0.4)' }, { transform: 'scale(1.18)', offset: 0.6 }, { transform: 'none' }],
    { duration: CHECK_POP_MS, easing: SPRING },
  );
}

/**
 * Patch rising into the panel: up from squashed below, stretching past, settling.
 * The package plays Patch's own move inside this; this only carries it in.
 */
export function patchArrive(stage: HTMLElement, delay = PATCH_ARRIVE_DELAY_MS): void {
  cancel(stage);
  if (reducedMotion()) {
    stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: PATCH_ARRIVE_MS / 2, delay, fill: 'backwards' });
    return;
  }
  stage.animate([
    { transform: 'translateY(48px) scale(0.6, 0.5)', opacity: 0 },
    { transform: 'translateY(-10px) scale(0.94, 1.1)', opacity: 1, offset: 0.45 },
    { transform: 'translateY(0) scale(1.06, 0.94)', offset: 0.7 },
    { transform: 'none', opacity: 1 },
  ], { duration: PATCH_ARRIVE_MS, easing: SPRING, delay, fill: 'backwards' });
}

/** Patch bowing out: a short drop and fade. */
export function patchLeave(stage: HTMLElement): Promise<void> {
  cancel(stage);
  const to = reducedMotion() ? { opacity: 0 } : { opacity: 0, transform: 'translateY(12px) scale(0.9)' };
  const anim = stage.animate([{ opacity: 1, transform: 'none' }, to], {
    duration: 220, easing: EASE_IN, fill: 'forwards',
  });
  return anim.finished.then(() => undefined, () => undefined);
}
