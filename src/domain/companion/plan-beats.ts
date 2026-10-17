/**
 * What Patch says when a plan levels up (A4): beside the confetti, or alone
 * under reduced motion, so the line has to carry the moment by itself.
 */
import type { PatchMood, PatchMove } from './patch';

export interface PlanBeat {
  move: PatchMove;
  mood: PatchMood;
  line: string;
}

export type PlanMoment =
  /** The plan moved on to `level` of `levels`. */
  | { kind: 'level-up'; level: number; levels: number }
  /** The last open issue closed; `levels` is how many the plan had. */
  | { kind: 'cleared'; levels: number };

/**
 * The beat for a moment.
 *
 * Level up: "Level up! On to level 3.", and reaching the last one "Level up!
 * Last level: 4 of 4." Cleared: "Plan cleared! Every last one." (a one-level
 * plan: "Plan cleared! That's the lot.").
 */
export function planBeat(moment: PlanMoment): PlanBeat {
  switch (moment.kind) {
    case 'level-up':
      return moment.level >= moment.levels
        ? { move: 'twirl', mood: 'happy', line: `Level up! Last level: ${moment.level} of ${moment.levels}.` }
        : { move: 'hop', mood: 'happy', line: `Level up! On to level ${moment.level}.` };
    case 'cleared':
      return moment.levels > 1
        ? { move: 'love', mood: 'happy', line: 'Plan cleared! Every last one.' }
        : { move: 'love', mood: 'happy', line: 'Plan cleared! That’s the lot.' };
  }
}
