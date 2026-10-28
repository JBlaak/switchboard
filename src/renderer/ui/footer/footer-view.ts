/**
 * What the footer's parts show, decided apart from the components that draw
 * them: a gauge's colour, fill and tooltip, the update notice's label and
 * button, and what installing asks first.
 *
 * Pure, so the rules load in node and are tested there.
 */
import { shortUsageLabel } from '../../../domain/usage/usage';
import type { UsageLimit } from '../../../domain/usage/usage';
import type { UpdateNotice } from '../../../domain/update/release';
import type { UpdateState } from '../../state/update-slice';

/**
 * Where a bar changes colour. The weekly window turns later: it fills over
 * days, so 60% of it is no cause for alarm the way 60% of five hours is.
 */
const THRESHOLDS = {
  session: { mid: 60, high: 80 },
  weekly: { mid: 80, high: 90 },
} as const;

export interface QuotaGaugeView {
  /** The short label on the gauge ("5h", "Week"). */
  readonly label: string;
  /** The full label, the percentage and the reset. */
  readonly tooltip: string;
  /** The fill's classes, coloured from mid and again from high (see THRESHOLDS). */
  readonly fillClass: string;
  /** The fill's CSS width. */
  readonly width: string;
  readonly percentText: string;
}

export function quotaGaugeView(row: UsageLimit): QuotaGaugeView {
  const { percent } = row;
  const { mid, high } = row.kind === 'weekly_all' ? THRESHOLDS.weekly : THRESHOLDS.session;
  const level = percent >= high ? ' quota-high' : percent >= mid ? ' quota-mid' : '';
  return {
    label: shortUsageLabel(row),
    // The full label ("Week (all models)") is too long for a gauge row; the
    // tooltip carries it, along with when the window resets.
    tooltip: `${row.label}: ${percent}%` + (row.reset ? ` — resets ${row.reset}` : ''),
    fillClass: 'quota-fill' + level,
    // Clamped to a visible minimum: a 0% bar reads as a broken element.
    width: Math.min(Math.max(percent, 1), 100) + '%',
    percentText: `${percent}%`,
  };
}

export interface UpdateNoticeView {
  readonly label: string;
  readonly action: string;
  readonly actionTitle: string;
}

/** The notice's line and button for a release on offer. */
export function updateNoticeView(notice: UpdateNotice, state: Pick<UpdateState, 'installing' | 'failed'>): UpdateNoticeView {
  const { installing, failed } = state;
  return {
    label: failed ? 'Update failed' : `Version ${notice.version} is available`,
    action: installing ? 'Installing…' : failed ? 'Retry' : notice.installable ? 'Install' : 'View',
    actionTitle: notice.installable ? 'Download, replace this app and restart' : 'Open the release page',
  };
}

/**
 * What to ask before installing, or null to install straight away: the
 * restart stops every running session, so that is asked first when any are.
 */
export function installConfirmation(running: number): string | null {
  if (running === 0) return null;
  return `Restarting to update stops ${running} running session${running === 1 ? '' : 's'}. Install now?`;
}
