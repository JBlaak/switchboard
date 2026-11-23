/**
 * The Schedule manager's page, from the schedule files and their runs: which
 * group each schedule sits in, what a run of it typically takes, the order
 * the overview lists them in and the wake it suggests.
 *
 * Cost is told as a share of the weekly limit, never in money: a run's share
 * is the all-models week it ended on minus the one it started on.
 */
import {clockTime, earliestTimeOfDay, nextRunAfter} from './next-run';
import type {
    RunStatus,
    ScheduleDetail,
    ScheduleGroup,
    ScheduleManagerFacts,
    ScheduleRun,
    ScheduleRunsOn,
    ScheduleSettings,
    ScheduleSummary,
    PromptVersion,
} from './manager';

/** How many runs the overview's strip shows. */
export const LAST_RUNS = 14;
/** How many runs a schedule's page lists. */
export const DETAIL_RUNS = 50;
/** How far back the night strip and the shelf look. */
export const RECENT_RUNS_MS = 36 * 60 * 60 * 1000;
/** How long before the earliest nightly run the suggested wake is. */
export const WAKE_LEAD_MINUTES = 5;
/** The nightly window the wake is for: 00:00 to 07:00. */
const NIGHT_FROM = 0;
const NIGHT_TO = 7 * 60;

/** What the page needs to know of one schedule file (the engine's `ScheduleEntry`). */
export interface ScheduleFileFacts {
    readonly key: string;
    readonly settings: ScheduleSettings;
    readonly runsOn: ScheduleRunsOn;
    readonly isNew: boolean;
}

/** The statuses a run needs looking at for, when the user has not seen it yet. */
const NEEDS_LOOKING_AT: ReadonlySet<RunStatus> = new Set(['failed', 'limit', 'missed']);

/**
 * A run the week cap skipped. The run store says why only in words ("the week
 * was past 80%"), and of the skips only this one is something the user may
 * want to act on: one they asked for, or one the previous run still held, is not.
 */
export function skippedByCap(run: ScheduleRun): boolean {
    return run.status === 'skipped' && run.reason !== null && /\bweek\b/i.test(run.reason);
}

/** Whether this run puts its schedule under Needs you. */
export function runNeedsYou(run: ScheduleRun): boolean {
    return !run.seen && (NEEDS_LOOKING_AT.has(run.status) || skippedByCap(run));
}

/** The group a schedule sits in, from its newest run first and its file after. */
export function scheduleGroup(file: ScheduleFileFacts, newest: ScheduleRun | null, running: boolean): ScheduleGroup {
    if (newest && runNeedsYou(newest)) return 'needsYou';
    if (running || newest?.status === 'running') return 'running';
    if (!file.settings.enabled) return 'paused';
    if (file.isNew) return 'new';
    return 'scheduled';
}

/** Runs that ran and ended: the ones a length or a share can be read from. */
function finished(runs: readonly ScheduleRun[]): ScheduleRun[] {
    return runs.filter((run) => run.status === 'done' || run.status === 'failed' || run.status === 'limit');
}

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return Math.round(value * 10) / 10;
}

/** A run's length in minutes; null when it never started or has not ended. */
export function runMinutes(run: ScheduleRun): number | null {
    if (run.startedAt === null || run.endedAt === null) return null;
    return Math.max(0, run.endedAt - run.startedAt) / 60_000;
}

/** The share of the week a run used, in percent; null when either end is unknown. A week reset mid-run reads as none. */
export function runWeekShare(run: ScheduleRun): number | null {
    if (run.weekBefore === null || run.weekAfter === null) return null;
    return Math.max(0, run.weekAfter - run.weekBefore);
}

/** The median length, in minutes, of these runs' finished ones. */
export function typicalMinutes(runs: readonly ScheduleRun[]): number | null {
    return median(
        finished(runs)
            .map(runMinutes)
            .filter((m): m is number => m !== null),
    );
}

/** The median share of the week these runs' finished ones used. */
export function typicalWeekShare(runs: readonly ScheduleRun[]): number | null {
    return median(
        finished(runs)
            .map(runWeekShare)
            .filter((s): s is number => s !== null),
    );
}

/** What the summary is built from. Runs are newest first. */
export interface SummaryInput {
    readonly file: ScheduleFileFacts;
    readonly runs: readonly ScheduleRun[];
    readonly running: boolean;
    /** The prompt's current version; 0 when none is recorded. */
    readonly promptVersion: number;
    readonly now: number;
}

/** One schedule on the overview. */
export function scheduleSummary(input: SummaryInput): ScheduleSummary {
    const {file, runs, running, promptVersion, now} = input;
    const newest = runs[0] ?? null;
    const group = scheduleGroup(file, newest, running);
    const waiting = file.settings.enabled && !file.isNew;
    return {
        key: file.key,
        settings: file.settings,
        runsOn: file.runsOn,
        group,
        nextRunAt: waiting ? nextRunAfter(file.settings.cron, now) : null,
        lastRuns: runs
            .slice(0, LAST_RUNS)
            .reverse()
            .map((run) => run.status),
        last: newest,
        typicalMinutes: typicalMinutes(runs),
        typicalWeekShare: typicalWeekShare(runs),
        promptVersion,
    };
}

/** Monday 00:00 local of the week `now` is in, as epoch ms. */
export function startOfWeek(now: number): number {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    return day.getTime();
}

/**
 * One schedule's page. `runs` is every run the store keeps of it, newest
 * first: the page lists the newest 50, and the stats count them all.
 */
export function scheduleDetail(
    summary: ScheduleSummary,
    runs: readonly ScheduleRun[],
    versions: readonly PromptVersion[],
    now: number,
): ScheduleDetail {
    const started = runs.map((run) => run.startedAt).filter((at): at is number => at !== null);
    const weekStart = startOfWeek(now);
    const thisWeek = runs.filter((run) => run.startedAt !== null && run.startedAt >= weekStart);
    const thisWeekShares = finished(thisWeek)
        .map(runWeekShare)
        .filter((s): s is number => s !== null);
    return {
        summary,
        runs: runs.slice(0, DETAIL_RUNS),
        versions,
        stats: {
            total: runs.length,
            done: runs.filter((run) => run.status === 'done').length,
            failed: runs.filter((run) => run.status === 'failed' || run.status === 'limit').length,
            caughtUp: runs.filter((run) => run.trigger === 'catch-up').length,
            since: started.length > 0 ? Math.min(...started) : null,
            medianMinutes: typicalMinutes(runs),
            medianWeekShare: typicalWeekShare(runs),
            thisWeekShare:
                thisWeek.length === 0
                    ? 0
                    : thisWeekShares.length === 0
                      ? null
                      : Math.round(thisWeekShares.reduce((a, b) => a + b, 0) * 10) / 10,
        },
    };
}

const GROUP_ORDER: readonly ScheduleGroup[] = ['needsYou', 'running', 'scheduled', 'new', 'paused'];

/** The overview's order: Needs you, Running, Scheduled by its next time, New, Paused; by name within a group. */
export function orderSummaries(summaries: readonly ScheduleSummary[]): ScheduleSummary[] {
    return [...summaries].sort((a, b) => {
        const group = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
        if (group !== 0) return group;
        if (a.group === 'scheduled') {
            const next = (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity);
            if (next !== 0 && !Number.isNaN(next)) return next;
        }
        return a.settings.name.localeCompare(b.settings.name);
    });
}

/**
 * The wake Switchboard suggests: five minutes before the earliest nightly
 * (00:00–07:00) time of any schedule that runs on this Mac, on and turned on
 * from Switchboard; null when none runs at night.
 */
export function suggestedWakeAt(files: readonly ScheduleFileFacts[]): string | null {
    const times = files
        .filter((file) => file.runsOn.kind === 'mac' && file.settings.enabled && !file.isNew)
        .map((file) => earliestTimeOfDay(file.settings.cron, NIGHT_FROM, NIGHT_TO))
        .filter((at): at is number => at !== null);
    if (times.length === 0) return null;
    return clockTime(Math.min(...times) - WAKE_LEAD_MINUTES);
}

/** Everything the overview needs, from its parts. */
export function managerFacts(input: {
    readonly summaries: readonly ScheduleSummary[];
    readonly files: readonly ScheduleFileFacts[];
    readonly recentRuns: readonly ScheduleRun[];
    readonly wakeAt: string | null;
    readonly week: number | null;
}): ScheduleManagerFacts {
    return {
        schedules: orderSummaries(input.summaries),
        recentRuns: input.recentRuns,
        wakeAt: input.wakeAt,
        suggestedWakeAt: suggestedWakeAt(input.files),
        week: input.week,
    };
}
