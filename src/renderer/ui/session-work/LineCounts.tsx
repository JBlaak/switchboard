/** `+a −d`: lines added in green ink, removed in red, for an item or a file. */
import type { JSX } from 'react';
import type { LineStats } from '../../../domain/session-work/model';

export function LineCounts({ stats }: { stats: LineStats }): JSX.Element {
  return (
    <span className="sw-counts" title={`${stats.additions} added, ${stats.deletions} removed`}>
      <span className="sw-count-add">+{stats.additions}</span>
      <span className="sw-count-del">−{stats.deletions}</span>
    </span>
  );
}
