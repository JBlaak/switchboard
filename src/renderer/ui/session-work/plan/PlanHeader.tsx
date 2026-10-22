/**
 * The plan's header (D2): where it lives, its title and the parent above it,
 * the level you are on, how much is closed, the linked PRs, and one progress
 * bullet per level.
 */
import type { JSX } from 'react';
import type { Plan, PlanLayout } from '../../../../domain/plan/model';
import { closedCount, hereLabel, issueUrl, linkedPrCount, planLevelBullets, shortRef } from './describe';
import { LevelBullets } from './LevelBullets';
import type { PlanHandlers } from './types';

export function PlanHeader({ plan, layout, on }: { plan: Plan; layout: PlanLayout; on: PlanHandlers }): JSX.Element {
  const bullets = planLevelBullets(layout);
  return (
    <div className="pv-header">
      <div className="pv-heading">
        <div className="pv-crumbs">
          <span>{plan.repository}</span>
          <span className="pv-crumb-sep" aria-hidden="true">/</span>
          <a
            className="pv-num"
            href={issueUrl(plan)}
            onClick={(e) => { e.preventDefault(); on.open(issueUrl(plan)); }}
          >
            {'#' + plan.number}
          </a>
          {plan.parent && (
            <>
              <span className="pv-crumb-sep" aria-hidden="true">·</span>
              <span>part of</span>
              <a
                className="pv-parent"
                href={issueUrl(plan.parent)}
                onClick={(e) => { e.preventDefault(); on.open(issueUrl(plan.parent!)); }}
              >
                {shortRef(plan, plan.parent) + ' ' + plan.parent.title}
              </a>
            </>
          )}
        </div>
        <h2 className="pv-title">{plan.title}</h2>
      </div>
      <div className="pv-stats">
        <div className="pv-counts">
          <b className="pv-here">{hereLabel(layout)}</b>
          <span><b>{closedCount(plan)}</b> of {plan.issues.length} closed</span>
          <span><b>{linkedPrCount(plan)}</b> PRs linked</span>
        </div>
        {bullets.length > 0 && <LevelBullets bullets={bullets} className="pv-progress" />}
      </div>
    </div>
  );
}
