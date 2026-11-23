/** Schedules, runs and facts for the Schedule manager's tests, in local time around Monday 23 November 2026. */
import type {
    PromptVersion,
    ScheduleDetail,
    ScheduleManagerFacts,
    ScheduleRun,
    ScheduleSettings,
    ScheduleSummary,
} from '../../src/domain/schedule/manager';

export const MIN = 60_000;

/** Local time on a day of November 2026 (the 23rd is a Monday). */
export function at(day: number, hour: number, minute = 0): number {
    return new Date(2026, 10, day, hour, minute).getTime();
}

/** Monday 23 November, 14:00. */
export const NOW = at(23, 14);

export function settings(fields: Partial<ScheduleSettings> = {}): ScheduleSettings {
    return {
        name: 'Bugsnag sweep',
        slug: 'bugsnag-sweep',
        projectPath: '/Users/me/Development/web',
        cron: '0 3 * * *',
        enabled: true,
        prompt: 'Fix the worst errors.',
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        allowedTools: 'Bash,Read',
        limitMinutes: 20,
        weekCap: 80,
        missed: 'run-once',
        worktree: true,
        ...fields,
    };
}

export function run(id: string, fields: Partial<ScheduleRun> = {}): ScheduleRun {
    return {
        id,
        scheduleKey: '/Users/me/Development/web/.claude/commands/schedule-bugsnag-sweep.md',
        sessionId: `session-${id}`,
        trigger: 'cron',
        dueAt: at(23, 3),
        startedAt: at(23, 3),
        endedAt: at(23, 3, 12),
        status: 'done',
        reason: null,
        promptVersion: 1,
        report: 'Fixed one error.',
        weekBefore: 40,
        weekAfter: 42,
        worktree: null,
        seen: true,
        ...fields,
    };
}

export function summary(
    key: string,
    fields: Partial<ScheduleSummary> = {},
    set: Partial<ScheduleSettings> = {},
): ScheduleSummary {
    return {
        key,
        settings: settings({name: key, slug: key, ...set}),
        runsOn: {kind: 'mac'},
        group: 'scheduled',
        nextRunAt: at(24, 3),
        lastRuns: ['done'],
        last: null,
        typicalMinutes: 10,
        typicalWeekShare: 2,
        promptVersion: 1,
        ...fields,
    };
}

export function facts(fields: Partial<ScheduleManagerFacts> = {}): ScheduleManagerFacts {
    return {schedules: [], recentRuns: [], wakeAt: null, suggestedWakeAt: null, week: null, ...fields};
}

export function version(n: number, savedAt: number, note: string | null = null): PromptVersion {
    return {version: n, text: `prompt v${n}`, savedAt, note};
}

export function detail(fields: Partial<ScheduleDetail> = {}): ScheduleDetail {
    return {
        summary: summary('/p/.claude/commands/schedule-a.md'),
        runs: [],
        versions: [],
        stats: {
            total: 0,
            done: 0,
            failed: 0,
            caughtUp: 0,
            since: null,
            medianMinutes: null,
            medianWeekShare: null,
            thisWeekShare: null,
        },
        ...fields,
    };
}
