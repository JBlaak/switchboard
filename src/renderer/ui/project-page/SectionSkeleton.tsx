/** A section waiting for the overview's first answer: its rows as grey bars (#175, as #174's plans do). */
import type { JSX } from 'react';

export function SectionSkeleton({ label, rows = 3 }: { label: string; rows?: number }): JSX.Element {
  return (
    <div className="pp-skeletons" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="pp-skeleton" />)}
    </div>
  );
}
