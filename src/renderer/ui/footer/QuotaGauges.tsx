/**
 * The quota bars: one for the 5-hour session window and one for the weekly
 * all-models window.
 *
 * Which one bites first varies, and the 5-hour is usually the emptiest while
 * resetting within the day, so showing a single window would read as "plenty
 * left" while the weekly one is the one actually running out. The per-model
 * weekly windows are filtered out before the rows reach the store (see
 * `usageGaugeRows`).
 */
import { useStore } from '../use-store';
import { quotaGaugeView } from './footer-view';
import type { JSX } from 'react';
import type { UsageLimit } from '../../../domain/usage/usage';

export function QuotaGauges(): JSX.Element {
  const rows = useStore(state => state.usage.rows);
  // Hidden rather than absent while nothing is known, as the vanilla markup
  // had it, so the footer's structure does not change with the data.
  return (
    <div id="sidebar-footer-quota" style={rows.length ? undefined : { display: 'none' }}>
      {rows.map(row => <QuotaGauge key={row.kind ?? row.label} row={row} />)}
    </div>
  );
}

function QuotaGauge({ row }: { row: UsageLimit }): JSX.Element {
  const gauge = quotaGaugeView(row);
  return (
    <span className="quota-item" title={gauge.tooltip}>
      <span className="quota-label">{gauge.label}</span>
      <span className="quota-track">
        <span className={gauge.fillClass} data-testid="quota-fill" style={{ width: gauge.width }} />
      </span>
      <span className="quota-pct">{gauge.percentText}</span>
    </span>
  );
}
