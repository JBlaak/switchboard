/**
 * A plan's progress as one bullet per level: done once every issue on it is
 * closed, in progress once any of them is closed or has a PR, open before.
 */
import type { NodeState } from './model';

export type LevelBullet = 'done' | 'in-progress' | 'open';

const CLOSED: readonly NodeState[] = ['merged', 'closed', 'not-planned'];
const STARTED: readonly NodeState[] = [...CLOSED, 'review', 'draft'];

/** One bullet per level, from the states of the issues on it. */
export function levelBullets(levels: readonly (readonly NodeState[])[]): LevelBullet[] {
  return levels.map(states => {
    if (states.length && states.every(state => CLOSED.includes(state))) return 'done';
    if (states.some(state => STARTED.includes(state))) return 'in-progress';
    return 'open';
  });
}

export const LEVEL_BULLET_LABEL: Readonly<Record<LevelBullet, string>> = {
  done: 'done',
  'in-progress': 'in progress',
  open: 'open',
};
