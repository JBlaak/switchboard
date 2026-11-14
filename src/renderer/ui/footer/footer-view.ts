/**
 * What the footer's parts show, decided apart from the components that draw
 * them: a gauge's colour, fill and tooltip, the update notice's label and
 * button, and what installing asks first.
 *
 * Pure, so the rules load in node and are tested there.
 */
import {shortUsageLabel} from '../../../domain/usage/usage';
import type {UsageLimit} from '../../../domain/usage/usage';
import {downloadPercent, formatMegabytes} from '../../../domain/update/progress';
import type {UpdateNotice} from '../../../domain/update/release';
import type {InstallProgress, InstallStep, UpdateOutcome} from '../../../domain/update/progress';
import type {UpdateState} from '../../state/update-slice';

/**
 * Where a bar changes colour. The weekly window turns later: it fills over
 * days, so 60% of it is no cause for alarm the way 60% of five hours is.
 */
const THRESHOLDS = {
    session: {mid: 60, high: 80},
    weekly: {mid: 80, high: 90},
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
    const {percent} = row;
    const {mid, high} = row.kind === 'weekly_all' ? THRESHOLDS.weekly : THRESHOLDS.session;
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
    /** More about the line, for its tooltip: download sizes, or why an install failed. */
    readonly detail: string | null;
    /** The button's text; null while an install runs, which cannot be stopped. */
    readonly action: string | null;
    readonly actionTitle: string;
    /** The bar under the line: a fraction, 'indeterminate' for a step of unknown length, or null for none. */
    readonly bar: number | 'indeterminate' | null;
    /** Whether the × shows; not while an install runs. */
    readonly dismissible: boolean;
}

/** What the line says while each step of an install runs. */
function progressLine(
    version: string,
    progress: InstallProgress | null,
): Pick<UpdateNoticeView, 'label' | 'detail' | 'bar'> {
    if (!progress) return {label: `Starting the ${version} download…`, detail: null, bar: 'indeterminate'};
    switch (progress.step) {
        case 'downloading': {
            const {received, total} = progress;
            const percent = downloadPercent(received, total);
            if (percent === null) {
                return {
                    label: `Downloading ${version}… ${formatMegabytes(received)}`,
                    detail: null,
                    bar: 'indeterminate',
                };
            }
            return {
                label: `Downloading ${version}… ${percent}%`,
                detail: `${formatMegabytes(received)} of ${formatMegabytes(total!)}`,
                bar: percent / 100,
            };
        }
        case 'unpacking':
            return {label: `Unpacking ${version}…`, detail: null, bar: 'indeterminate'};
        case 'checking':
            return {label: `Checking ${version}…`, detail: null, bar: 'indeterminate'};
        case 'restarting':
            return {label: `Restarting into ${version}…`, detail: null, bar: 1};
    }
}

const FAILED_AT: Record<InstallStep, string> = {
    downloading: 'Download failed',
    unpacking: 'Unpacking failed',
    checking: 'The download is damaged',
    restarting: 'Restart failed',
};

/** The notice's line, bar and button for a release on offer. */
export function updateNoticeView(
    notice: UpdateNotice,
    state: Pick<UpdateState, 'installing' | 'progress' | 'failure'>,
): UpdateNoticeView {
    const {installing, progress, failure} = state;
    const actionTitle = notice.installable ? 'Download, replace this app and restart' : 'Open the release page';
    if (installing) {
        return {...progressLine(notice.version, progress), action: null, actionTitle, dismissible: false};
    }
    if (failure) {
        return {
            label: FAILED_AT[failure.step],
            detail: `${failure.reason} This app was left as it was.`,
            action: 'Retry',
            actionTitle,
            bar: null,
            dismissible: true,
        };
    }
    return {
        label: `Version ${notice.version} is available`,
        detail: null,
        action: notice.installable ? 'Install' : 'View',
        actionTitle,
        bar: null,
        dismissible: true,
    };
}

/** The line after a restart: whether the install arrived. */
export function updateOutcomeView(outcome: UpdateOutcome): {label: string; detail: string | null} {
    if (outcome.kind === 'updated') return {label: `Updated to ${outcome.version}`, detail: null};
    return {
        label: `Update to ${outcome.version} didn't apply`,
        detail: `Switchboard restarted on ${outcome.running}. Try installing again, or download it from the release page.`,
    };
}

/** The footer's count of running sessions, or nothing when none are. */
export function runningLabel(running: number): string {
    return running > 0 ? `${running} running` : '';
}

/**
 * What to ask before installing, or null to install straight away: the
 * restart stops every running session, so that is asked first when any are.
 */
export function installConfirmation(running: number): string | null {
    if (running === 0) return null;
    return `Restarting to update stops ${running} running session${running === 1 ? '' : 's'}. Install now?`;
}
