/**
 * The quota bars in the status bar.
 *
 * One per limit window the usage API reports — a 5-hour session window, a
 * weekly all-models window, and a weekly window per model. Which one bites
 * first varies, and the 5-hour is usually the emptiest while resetting within
 * the day, so showing a single window would read as "plenty left" while a
 * weekly one is the one actually running out.
 *
 * The rows come from the API self-describing, so a newly launched model gets a
 * bar without a code change here.
 */
import { shortUsageLabel, usageGaugeRows } from '../../domain/usage/usage';
import { el } from '../lib/dom';
import type { UsageLimit } from '../../domain/usage/usage';

/** How often the gauges are re-fetched. */
const REFRESH_MS = 5 * 60 * 1000;

/** Where a bar changes colour. */
const HIGH_PERCENT = 80;
const MID_PERCENT = 60;

const gaugeEl = el('status-bar-quota');

export function installQuotaGauges(): void {
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS);

  // The bars are a summary of the stats tab; clicking them opens it.
  gaugeEl.addEventListener('click', () => {
    document.querySelector<HTMLElement>('.sidebar-tab[data-tab="stats"]')?.click();
  });
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
  // The full label ("Week (all models)") is too long for a status bar; the
  // tooltip carries it, along with when the window resets.
  wrap.title = `${row.label}: ${percent}%` + (row.reset ? ` — resets ${row.reset}` : '');
  return wrap;
}
