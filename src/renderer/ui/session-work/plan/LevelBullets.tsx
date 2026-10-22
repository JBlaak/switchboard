/**
 * A plan's progress as one bullet per level, coloured by its status: the plan
 * view's header and the project page's plan rows both show it.
 */
import type { JSX } from 'react';
import { LEVEL_BULLET_LABEL, type LevelBullet } from '../../../../domain/plan/level-progress';

export function LevelBullets({ bullets, className }: { bullets: readonly LevelBullet[]; className?: string }): JSX.Element {
  const label = 'Progress by level: ' + bullets.map((bullet, i) => `level ${i + 1} ${LEVEL_BULLET_LABEL[bullet]}`).join(', ');
  return (
    <span className={'level-bullets' + (className ? ' ' + className : '')} role="img" aria-label={label}>
      {bullets.map((bullet, i) => (
        <span key={i} className={'level-bullet is-' + bullet} title={`Level ${i + 1} · ${LEVEL_BULLET_LABEL[bullet]}`} />
      ))}
    </span>
  );
}
