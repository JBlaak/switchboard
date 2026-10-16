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
import { shortUsageLabel } from '../../../domain/usage/usage';
import { useStore } from '../use-store';
import type { JSX } from 'react';
import type { UsageLimit } from '../../../domain/usage/usage';

/** Where a bar changes colour. */
const HIGH_PERCENT = 80;
const MID_PERCENT = 60;

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
  const { percent } = row;
  const level = percent >= HIGH_PERCENT ? ' quota-high' : percent >= MID_PERCENT ? ' quota-mid' : '';
  // The full label ("Week (all models)") is too long for a gauge row; the
  // tooltip carries it, along with when the window resets.
  const tooltip = `${row.label}: ${percent}%` + (row.reset ? ` — resets ${row.reset}` : '');
  return (
    <span className="quota-item" title={tooltip}>
      <span className="quota-label">{shortUsageLabel(row)}</span>
      <span className="quota-track">
        <span
          className={'quota-fill' + level}
          data-testid="quota-fill"
          // Clamped to a visible minimum: a 0% bar reads as a broken element.
          style={{ width: Math.min(Math.max(percent, 1), 100) + '%' }}
        />
      </span>
      <span className="quota-pct">{`${percent}%`}</span>
    </span>
  );
}
