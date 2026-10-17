/** Status pills: a pastel fill with a matching ink, one per fact (see `describe.itemPills`). */
import type { JSX } from 'react';
import type { Pill } from './describe';

export function Pills({ pills }: { pills: readonly Pill[] }): JSX.Element | null {
  if (!pills.length) return null;
  return (
    <span className="sw-pills">
      {pills.map(pill => <span key={pill.label} className={'sw-pill is-' + pill.tone}>{pill.label}</span>)}
    </span>
  );
}
