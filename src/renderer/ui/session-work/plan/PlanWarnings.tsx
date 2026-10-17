/** The warnings above the diagram (D5): said, never fixed. */
import type { JSX } from 'react';
import type { Plan, PlanLayout } from '../../../../domain/plan/model';
import { warningText } from './describe';

export function PlanWarnings({ plan, layout }: { plan: Plan; layout: PlanLayout }): JSX.Element | null {
  if (!layout.warnings.length) return null;
  return (
    <div className="pv-warnings">
      {layout.warnings.map((warning, i) => {
        const { title, text } = warningText(plan, warning);
        return (
          <div key={i} className="pv-warning" role="note">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M8 1.8 15 14H1z" />
              <path d="M8 6.5v3.5M8 12v.2" />
            </svg>
            <span><b>{title}</b> {text}</span>
          </div>
        );
      })}
    </div>
  );
}
