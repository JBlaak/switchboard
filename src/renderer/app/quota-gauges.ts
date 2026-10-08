/**
 * The quota bars in the sidebar footer.
 *
 * One for the 5-hour session window and one for the weekly all-models window.
 * Which one bites first varies, and the 5-hour is usually the emptiest while
 * resetting within the day, so showing a single window would read as "plenty
 * left" while the weekly one is the one actually running out. The per-model
 * weekly windows are filtered out in usageGaugeRows.
 */
import { shortUsageLabel, usageGaugeRows } from '../../domain/usage/usage';
import { el } from '../lib/dom';
import type { UsageLimit } from '../../domain/usage/usage';

/** How often the gauges are re-fetched. */
const REFRESH_MS = 5 * 60 * 1000;

/** Where a bar changes colour. */
const HIGH_PERCENT = 80;
const MID_PERCENT = 60;

const gaugeEl = el('sidebar-footer-quota');

export function installQuotaGauges(): void {
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS);
}

async function refresh(): Promise<void> {
  try {
    const rows = usageGaugeRows(await window.api.getUsage());
    if (!rows.length) {
      gaugeEl.style.display = 'none';
      return;
    }
    gaugeEl.replaceChildren(...rows.map(buildBar));
    gaugeEl.style.display = '';
  } catch {
    // Offline, or no credentials; leave whatever is on screen.
  }
}

function buildBar(row: UsageLimit): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'quota-item';

  const label = document.createElement('span');
  label.className = 'quota-label';
  label.textContent = shortUsageLabel(row);

  const track = document.createElement('span');
  track.className = 'quota-track';

  const fill = document.createElement('span');
  const percent = row.percent;
  fill.className = 'quota-fill'
    + (percent >= HIGH_PERCENT ? ' quota-high' : percent >= MID_PERCENT ? ' quota-mid' : '');
  // Clamped to a visible minimum: a 0% bar reads as a broken element.
  fill.style.width = Math.min(Math.max(percent, 1), 100) + '%';
  track.appendChild(fill);

  const value = document.createElement('span');
  value.className = 'quota-pct';
  value.textContent = percent + '%';

  wrap.append(label, track, value);
  // The full label ("Week (all models)") is too long for a gauge row; the
  // tooltip carries it, along with when the window resets.
  wrap.title = `${row.label}: ${percent}%` + (row.reset ? ` — resets ${row.reset}` : '');
  return wrap;
}
