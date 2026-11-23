/**
 * The Schedule manager's night strip: last night and tonight, each a track
 * from 22:00 to 08:00, with a block per run where it fell (coloured by what
 * became of it), tonight's coming runs as outlines where they will fall, and
 * the Mac's wake as a marker.
 *
 * Positions are percent of the track from its left edge.
 */
import type {RunStatus, ScheduleManagerFacts, ScheduleRun, ScheduleSummary} from './manager';
import {
    clockMinutes,
    lastNightWindow,
    NIGHT_END_HOUR,
    NIGHT_START_HOUR,
    tonightWindow,
    type NightWindow,
} from './times';

const MINUTE = 60_000;

/** The narrowest a block is drawn, so a one-minute run still shows. */
export const MIN_BLOCK_PERCENT = 1.2;

/** A run's colour on the page, by what became of it. */
export type RunTone = 'done' | 'late' | 'failed' | 'missed' | 'skipped' | 'running';

export function runTone(run: Pick<ScheduleRun, 'status' | 'trigger'>): RunTone {
    return statusTone(run.status, run.trigger === 'catch-up');
}

/** A status's colour; a catch-up that finished is `late`, blue rather than green. */
export function statusTone(status: RunStatus, caughtUp = false): RunTone {
    switch (status) {
        case 'done':
            return caughtUp ? 'late' : 'done';
        case 'failed':
        case 'limit':
            return 'failed';
        case 'missed':
            return 'missed';
        case 'skipped':
            return 'skipped';
        case 'running':
            return 'running';
    }
}

export interface NightBlock {
    /** A run's id, or the schedule's key for a coming one. */
    readonly id: string;
    readonly scheduleKey: string;
    readonly left: number;
    readonly width: number;
    readonly tone: RunTone;
    /** Still to come: drawn as an outline. */
    readonly planned: boolean;
    /** Its schedule's name and the time, for the title. */
    readonly label: string;
}

export interface NightTrack {
    readonly window: NightWindow;
    readonly blocks: readonly NightBlock[];
}

export interface NightStrip {
    readonly lastNight: NightTrack;
    readonly tonight: NightTrack;
    /** The wake marker, when the Mac's wake falls in the night. */
    readonly wake: {readonly at: string; readonly left: number} | null;
    /** The axis labels and where they stand. */
    readonly ticks: readonly {readonly label: string; readonly left: number}[];
    /** "4 done · 1 failed · 1 caught up late", and the week used, for last night. */
    readonly summary: NightSummary;
}

export interface NightSummary {
    readonly done: number;
    readonly failed: number;
    readonly caughtUp: number;
    readonly missed: number;
    /** The week's share last night's runs used, summed; null when none was read. */
    readonly weekUsed: number | null;
}

/** Where `at` falls on a track, in percent; clamped to it. */
export function nightPosition(window: NightWindow, at: number): number {
    const span = window.end - window.start;
    return Math.min(100, Math.max(0, ((at - window.start) / span) * 100));
}

function inWindow(window: NightWindow, at: number): boolean {
    return at >= window.start && at < window.end;
}

/** When a run is drawn from: its start, or the time it was due when it never started. */
function runStart(run: ScheduleRun): number | null {
    return run.startedAt ?? run.dueAt;
}

/** To a hundredth of a percent: finer is no use on screen, and it keeps the numbers readable. */
function hundredths(percent: number): number {
    return Math.round(percent * 100) / 100;
}

function block(window: NightWindow, from: number, to: number): {left: number; width: number} {
    const left = nightPosition(window, from);
    const width = hundredths(Math.max(MIN_BLOCK_PERCENT, nightPosition(window, to) - left));
    return {left: hundredths(Math.min(left, 100 - width)), width};
}

function clock(at: number): string {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function runBlocks(
    window: NightWindow,
    runs: readonly ScheduleRun[],
    names: ReadonlyMap<string, string>,
    now: number,
): NightBlock[] {
    return runs.flatMap((run) => {
        const start = runStart(run);
        if (start === null || !inWindow(window, start)) return [];
        const end = run.endedAt ?? (run.status === 'running' ? now : start);
        return [
            {
                id: run.id,
                scheduleKey: run.scheduleKey,
                ...block(window, start, end),
                tone: runTone(run),
                planned: false,
                label: `${names.get(run.scheduleKey) ?? 'A schedule'} · ${clock(start)}`,
            },
        ];
    });
}

/** Tonight's coming runs: each schedule on and due in the window, as long as it usually takes (5 min when unknown). */
function plannedBlocks(window: NightWindow, schedules: readonly ScheduleSummary[], now: number): NightBlock[] {
    return schedules.flatMap((schedule) => {
        const at = schedule.nextRunAt;
        if (!schedule.settings.enabled || at === null || at < now || !inWindow(window, at)) return [];
        const minutes = schedule.typicalMinutes ?? 5;
        return [
            {
                id: `next:${schedule.key}`,
                scheduleKey: schedule.key,
                ...block(window, at, at + minutes * MINUTE),
                tone: schedule.last ? runTone(schedule.last) : 'done',
                planned: true,
                label: `${schedule.settings.name} · ${clock(at)}`,
            },
        ];
    });
}

function summaryOf(window: NightWindow, runs: readonly ScheduleRun[]): NightSummary {
    const night = runs.filter((run) => {
        const start = runStart(run);
        return start !== null && inWindow(window, start);
    });
    const shares = night.flatMap((run) =>
        run.weekBefore !== null && run.weekAfter !== null ? [Math.max(0, run.weekAfter - run.weekBefore)] : [],
    );
    return {
        done: night.filter((run) => run.status === 'done' && run.trigger !== 'catch-up').length,
        failed: night.filter((run) => run.status === 'failed' || run.status === 'limit').length,
        caughtUp: night.filter((run) => run.status === 'done' && run.trigger === 'catch-up').length,
        missed: night.filter((run) => run.status === 'missed').length,
        weekUsed: shares.length === 0 ? null : shares.reduce((sum, share) => sum + share, 0),
    };
}

/** A catch-up runs on waking, after 08:00 at times; the strip counts it to the night it was due in. */
function countedRuns(window: NightWindow, runs: readonly ScheduleRun[]): ScheduleRun[] {
    return runs.map((run) =>
        run.trigger === 'catch-up' && run.dueAt !== null && inWindow(window, run.dueAt) && run.startedAt !== null
            ? run.startedAt >= window.end
                ? {...run, startedAt: Math.min(run.startedAt, window.end - MINUTE), endedAt: window.end}
                : run
            : run,
    );
}

function wakeMarker(window: NightWindow, wakeAt: string | null): NightStrip['wake'] {
    if (!wakeAt) return null;
    const minutes = clockMinutes(wakeAt);
    if (minutes === null) return null;
    const hour = Math.floor(minutes / 60);
    if (hour >= NIGHT_END_HOUR && hour < NIGHT_START_HOUR) return null;
    const start = new Date(window.start);
    const day = hour >= NIGHT_START_HOUR ? start.getDate() : start.getDate() + 1;
    const at = new Date(start.getFullYear(), start.getMonth(), day, hour, minutes % 60).getTime();
    return {at: wakeAt, left: hundredths(nightPosition(window, at))};
}

const TICK_HOURS = [22, 0, 2, 4, 6, 8];

export function nightStrip(facts: ScheduleManagerFacts, now: number): NightStrip {
    const last = lastNightWindow(now);
    const tonight = tonightWindow(now);
    const names = new Map(facts.schedules.map((schedule) => [schedule.key, schedule.settings.name]));
    const lastRuns = countedRuns(last, facts.recentRuns);
    const span = 10;
    return {
        lastNight: {window: last, blocks: runBlocks(last, lastRuns, names, now)},
        tonight: {
            window: tonight,
            blocks: [
                ...runBlocks(tonight, facts.recentRuns, names, now),
                ...plannedBlocks(tonight, facts.schedules, now),
            ],
        },
        wake: wakeMarker(tonight, facts.wakeAt),
        ticks: TICK_HOURS.map((hour, index) => ({
            label: `${String(hour).padStart(2, '0')}:00`,
            left: ((index * 2) / span) * 100,
        })),
        summary: summaryOf(last, lastRuns),
    };
}

/** "4 done", "1 failed", "1 caught up late", "1 missed": the parts that are not none, each with its colour. */
export function nightSummaryParts(summary: NightSummary): {readonly tone: RunTone; readonly text: string}[] {
    return [
        {tone: 'done' as const, n: summary.done, text: `${summary.done} done`},
        {tone: 'failed' as const, n: summary.failed, text: `${summary.failed} failed`},
        {tone: 'late' as const, n: summary.caughtUp, text: `${summary.caughtUp} caught up late`},
        {tone: 'missed' as const, n: summary.missed, text: `${summary.missed} missed`},
    ]
        .filter((part) => part.n > 0)
        .map(({tone, text}) => ({tone, text}));
}
