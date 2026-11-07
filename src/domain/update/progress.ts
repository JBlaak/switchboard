/**
 * How far an install has got, and how it ended.
 *
 * An install runs four steps in order: download the zip, unpack it, check the
 * bundle inside, and restart into it. Main reports each as it starts, and the
 * download as it goes; the footer turns that into one line and a bar. A
 * failure names the step it stopped at, so the footer can say what went wrong
 * rather than only that something did.
 *
 * After the restart, the new app compares the version it was meant to become
 * with the one it is, and says which happened.
 */

export type InstallStep = 'downloading' | 'unpacking' | 'checking' | 'restarting';

export type InstallProgress =
    | {step: 'downloading'; received: number; total: number | null}
    | {step: 'unpacking'}
    | {step: 'checking'}
    | {step: 'restarting'};

/** Where an install stopped, and why, in words for a tooltip. */
export interface InstallFailure {
    step: InstallStep;
    reason: string;
}

/** What `installUpdate` answers. On success the app quits instead of answering. */
export type InstallResult = {ok: true} | {ok: false; failure: InstallFailure};

/** The update main handed to the swap before quitting, read back by the app that launches next. */
export interface PendingUpdate {
    from: string;
    to: string;
}

/** What the launch after an install found: the swap went through, or the old app came back. */
export type UpdateOutcome = {kind: 'updated'; version: string} | {kind: 'notApplied'; version: string; running: string};

/** What became of `pending`, for an app now running `running`. */
export function updateOutcome(pending: PendingUpdate, running: string): UpdateOutcome {
    return running === pending.to
        ? {kind: 'updated', version: pending.to}
        : {kind: 'notApplied', version: pending.to, running};
}

const MEGABYTE = 1_000_000;

/** Whole percent of a download, or null when its size is unknown. */
export function downloadPercent(received: number, total: number | null): number | null {
    if (!total || total <= 0) return null;
    return Math.min(100, Math.floor((received / total) * 100));
}

/** `41.2 MB`, as Finder counts them. */
export function formatMegabytes(bytes: number): string {
    return `${(bytes / MEGABYTE).toFixed(1)} MB`;
}

/**
 * Whether a download's progress has moved enough to tell the window again: a
 * whole percent when the size is known, a megabyte when it is not. Chunks
 * arrive every few kilobytes, and an event per chunk would flood the window.
 */
export function downloadWorthReporting(lastReported: number | null, received: number, total: number | null): boolean {
    if (lastReported === null) return true;
    const percent = downloadPercent(received, total);
    if (percent !== null) return percent !== downloadPercent(lastReported, total);
    return Math.floor(received / MEGABYTE) !== Math.floor(lastReported / MEGABYTE);
}
