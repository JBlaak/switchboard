/** Schedule manager facts for the Automatic shelf's tests: schedules and runs built from a few fields. */
import type {
    ScheduleManagerFacts,
    ScheduleRun,
    ScheduleSettings,
    ScheduleSummary,
} from '../../src/domain/schedule/manager';

/** A local time on 23 November 2026, so a test reads the clock it expects in any time zone. */
export function local(hour: number, minute = 0, day = 23): number {
    return new Date(2026, 10, day, hour, minute).getTime();
}

export function schedule(
    key: string,
    fields: Partial<Omit<ScheduleSummary, 'settings'>> & {settings?: Partial<ScheduleSettings>} = {},
): ScheduleSummary {
    const {settings, ...rest} = fields;
    return {
        key,
        settings: {
            name: 'Schedule ' + key,
            slug: key,
            projectPath: '/Users/me/dev/switchboard',
            cron: '0 3 * * *',
            enabled: true,
            prompt: 'Do the thing',
            model: null,
            permissionMode: 'default',
            allowedTools: '',
            limitMinutes: 20,
            weekCap: null,
            missed: 'skip',
            worktree: false,
            ...settings,
        },
        runsOn: {kind: 'mac'},
        group: 'scheduled',
        nextRunAt: null,
        lastRuns: [],
        last: null,
        typicalMinutes: null,
        typicalWeekShare: null,
        promptVersion: 1,
        ...rest,
    };
}

export function run(id: string, scheduleKey: string, fields: Partial<ScheduleRun> = {}): ScheduleRun {
    return {
        id,
        scheduleKey,
        sessionId: 's-' + id,
        trigger: 'cron',
        dueAt: local(3),
        startedAt: local(3),
        endedAt: local(3, 10),
        status: 'done',
        reason: null,
        promptVersion: 1,
        report: null,
        weekBefore: null,
        weekAfter: null,
        worktree: null,
        seen: false,
        ...fields,
    };
}

export function facts(
    schedules: readonly ScheduleSummary[],
    recentRuns: readonly ScheduleRun[] = [],
): ScheduleManagerFacts {
    return {schedules, recentRuns, wakeAt: null, suggestedWakeAt: null, week: null};
}
