/**
 * When a plan levels up (A4): the rule that decides whether a fetch of a plan
 * is worth confetti, from the level last seen for it and the level it is on
 * now.
 *
 * A level is `null` once the plan is cleared (P3). Whatever this answers, the
 * caller records `current` as the new level seen.
 */

/** What a fetch of a plan is worth: nothing, the next level reached, or the whole plan cleared. */
export type Celebration =
  | { readonly kind: 'none' }
  /** `level`: the level the plan is on now. */
  | { readonly kind: 'level-up'; readonly level: number }
  /** `level`: the last level seen, the one whose clearing cleared the plan. */
  | { readonly kind: 'cleared'; readonly level: number };

const NONE: Celebration = { kind: 'none' };

/**
 * Whether to celebrate a plan now on `current`, last seen on `lastSeen`.
 *
 * The first sighting of a plan never celebrates: there is nothing it moved
 * from. A level going back down (an issue reopened) or a cleared plan
 * reopening doesn't either; the caller only records it.
 */
export function shouldCelebrate(lastSeen: number | null, current: number | null, firstSighting: boolean): Celebration {
  if (firstSighting || lastSeen === null) return NONE;
  if (current === null) return { kind: 'cleared', level: lastSeen };
  return current > lastSeen ? { kind: 'level-up', level: current } : NONE;
}
