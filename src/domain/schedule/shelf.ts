/**
 * Scheduled runs on the Automatic shelf: which runs it lists, what each one
 * says, and which schedules come up next.
 *
 * A run is listed while it is going, and once it ended until the user has
 * seen it (opened its session or marked it read). A run that failed, hit its
 * time limit or was missed needs you until then. Runs that found nothing to
 * do arrive seen, so they never show. A seen run is an ordinary session
 * again, kept in the history and the archive as any other.
 *
 * Pure: the caller hands in the Schedule manager's facts and the time.
 */
import type {RunStatus, ScheduleManagerFacts, ScheduleRun, ScheduleSummary} from './manager';

/** How far ahead Coming up looks, and how many schedule times it shows. */
export const COMING_UP_WITHIN_MS = 12 * 3_600_000;
export const COMING_UP_COUNT = 2;

/** A finished run's outcome that only the user can follow up. */
const NEEDS_YOU: ReadonlySet<RunStatus> = new Set(['failed', 'limit', 'missed']);

/** What the shelf, the Blocked row and the session header need of one listed run. */
export interface ShelfRun {
    readonly id: string;
    readonly scheduleKey: string;
    /** The schedule's name, or "Scheduled run" when the schedule has gone. */
    readonly name: string;
    /** The session it runs in; null for a run that never started (missed, skipped). */
    readonly sessionId: string | null;
    readonly status: RunStatus;
    readonly reason: string | null;
    /** When it was due, started and ended (epoch ms), as far as it got. */
    readonly dueAt: number | null;
    readonly startedAt: number | null;
    readonly endedAt: number | null;
    /** In a few words: its due time while running, else its outcome ("limit hit", the report's first line). */
    readonly doing: string;
    readonly needsYou: boolean;
    /** The schedule's project, absolute. */
    readonly projectPath: string;
    /** The VM it runs on; null on this Mac. */
    readonly host: string | null;
}

/** A schedule's next time, as Coming up lists it. */
export interface ComingUpRun {
    readonly scheduleKey: string;
    readonly name: string;
    readonly at: number;
}

/** Whether the shelf lists this run: going now, or ended and not seen yet. */
export function isListedRun(run: ScheduleRun): boolean {
    return run.status === 'running' || !run.seen;
}

/** Whether a run needs the user: it failed, hit its limit or was missed, and is not seen yet. */
export function runNeedsYou(run: ScheduleRun): boolean {
    return !run.seen && NEEDS_YOU.has(run.status);
}

/** The time a run is ordered by on the shelf: when it ended, else started, else was due. */
export function runTime(run: Pick<ShelfRun, 'endedAt' | 'startedAt' | 'dueAt'>): number {
    return run.endedAt ?? run.startedAt ?? run.dueAt ?? 0;
}

/** Every run the shelf lists, newest first. */
export function listedRuns(facts: ScheduleManagerFacts | null): ShelfRun[] {
    if (!facts) return [];
    const schedules = new Map(facts.schedules.map((s) => [s.key, s]));
    return facts.recentRuns
        .filter(isListedRun)
        .map((run) => shelfRun(run, schedules.get(run.scheduleKey) ?? null))
        .sort((a, b) => runTime(b) - runTime(a));
}

function shelfRun(run: ScheduleRun, schedule: ScheduleSummary | null): ShelfRun {
    return {
        id: run.id,
        scheduleKey: run.scheduleKey,
        name: schedule?.settings.name || 'Scheduled run',
        sessionId: run.sessionId,
        status: run.status,
        reason: run.reason,
        dueAt: run.dueAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        doing: runDoing(run),
        needsYou: runNeedsYou(run),
        projectPath: schedule?.settings.projectPath ?? '',
        host: schedule?.runsOn.kind === 'vm' ? schedule.runsOn.host : null,
    };
}

/**
 * A run in a few words: the time it was due while it runs ("03:00"), else
 * what became of it: "limit hit", "failed", "missed", "skipped", or for one
 * that finished, its report's first line ("draft updated").
 */
export function runDoing(run: ScheduleRun): string {
    switch (run.status) {
        case 'running':
            return run.dueAt !== null ? clockTime(run.dueAt) : 'running';
        case 'done':
            return reportLine(run.report) ?? 'done';
        case 'failed':
            return 'failed';
        case 'limit':
            return 'limit hit';
        case 'missed':
            return 'missed';
        case 'skipped':
            return 'skipped';
    }
}

/** The longest a report's first line runs on the shelf before it is cut. */
const REPORT_LINE_LENGTH = 40;

/** A report's first line with its Markdown marks taken off, cut to fit; null for an empty report. */
export function reportLine(report: string | null): string | null {
    const line = (report ?? '')
        .split('\n')
        .map((l) =>
            l
                .replace(/^\s*(#+|[-*>]|\d+\.)\s*/, '')
                .replace(/[*_`]/g, '')
                .trim(),
        )
        .find((l) => l.length > 0);
    if (!line) return null;
    if (line.length <= REPORT_LINE_LENGTH) return line;
    return line.slice(0, REPORT_LINE_LENGTH - 1).trimEnd() + '…';
}

/**
 * The next schedule times, soonest first: at most `COMING_UP_COUNT`, of
 * schedules that are on, within `COMING_UP_WITHIN_MS` from now. A schedule
 * running now still shows its next time.
 */
export function comingUp(facts: ScheduleManagerFacts | null, now: number): ComingUpRun[] {
    if (!facts) return [];
    return facts.schedules
        .filter(
            (s) =>
                s.settings.enabled &&
                s.nextRunAt !== null &&
                s.nextRunAt > now &&
                s.nextRunAt - now <= COMING_UP_WITHIN_MS,
        )
        .map((s) => ({scheduleKey: s.key, name: s.settings.name, at: s.nextRunAt!}))
        .sort((a, b) => a.at - b.at)
        .slice(0, COMING_UP_COUNT);
}

/** The soonest time any schedule that is on runs next; null with none. */
export function nextScheduledAt(facts: ScheduleManagerFacts | null, now: number): number | null {
    let next: number | null = null;
    for (const s of facts?.schedules ?? []) {
        if (!s.settings.enabled || s.nextRunAt === null || s.nextRunAt <= now) continue;
        if (next === null || s.nextRunAt < next) next = s.nextRunAt;
    }
    return next;
}

/** Whether any schedule is on: then the shelf stays, so its folded line can say when the next one runs. */
export function anyScheduleOn(facts: ScheduleManagerFacts | null): boolean {
    return !!facts?.schedules.some((s) => s.settings.enabled);
}

/** `03:00`, in local time. */
export function clockTime(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A time to come: `03:00` within a day, with its weekday within the week,
 * `Mon 03:00`, and with its date further out, `1 Jan 03:00`, where a weekday
 * alone would read as this week.
 */
export function upcomingTime(at: number, now: number): string {
    const ahead = at - now;
    if (ahead < 24 * 3_600_000) return clockTime(at);
    const d = new Date(at);
    if (ahead < 7 * 24 * 3_600_000) return `${WEEKDAYS[d.getDay()]} ${clockTime(at)}`;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clockTime(at)}`;
}

/**
 * What the session header says of a run after "Scheduled run of <name> · ":
 * "running since 03:00", "done at 03:14", "failed at 03:05 · exit 1: …",
 * "stopped at 03:20 · its 20 min limit", "missed · the Mac was asleep at 03:00".
 */
export function runStatusText(run: ShelfRun): string {
    const at = (time: number | null): string => (time === null ? '' : ` at ${clockTime(time)}`);
    const why = run.reason ? ` · ${run.reason}` : '';
    switch (run.status) {
        case 'running':
            return run.startedAt === null ? 'running' : `running since ${clockTime(run.startedAt)}`;
        case 'done':
            return `done${at(run.endedAt)}`;
        case 'failed':
            return `failed${at(run.endedAt)}${why}`;
        case 'limit':
            return `stopped${at(run.endedAt)}${why}`;
        case 'missed':
            return `missed${why}`;
        case 'skipped':
            return `skipped${why}`;
    }
}
