/**
 * What the Schedule manager's page shows of the facts main pushes: its
 * groups (Needs you, Scheduled, New, Paused) in order, the header's line, the
 * wake it offers to set, a run's pill, where a schedule runs, a report's
 * first line, and the figure's pose.
 */
import type {RunStatus, ScheduleManagerFacts, ScheduleRun, ScheduleRunsOn, ScheduleSummary} from './manager';
import {nextRunText, runMinutes, tonightWindow} from './times';

// ── Groups ──

/** The page's groups, top to bottom. Running schedules sit with the scheduled ones, first. */
export type OverviewGroupId = 'needsYou' | 'scheduled' | 'new' | 'paused';

export interface OverviewGroup {
    readonly id: OverviewGroupId;
    readonly schedules: readonly ScheduleSummary[];
}

const GROUP_ORDER: readonly OverviewGroupId[] = ['needsYou', 'scheduled', 'new', 'paused'];

function groupOf(schedule: ScheduleSummary): OverviewGroupId {
    return schedule.group === 'running' ? 'scheduled' : schedule.group;
}

function lastAt(schedule: ScheduleSummary): number {
    const last = schedule.last;
    return last ? (last.endedAt ?? last.startedAt ?? last.dueAt ?? 0) : 0;
}

function byName(a: ScheduleSummary, b: ScheduleSummary): number {
    return a.settings.name.localeCompare(b.settings.name);
}

const ORDER: Record<OverviewGroupId, (a: ScheduleSummary, b: ScheduleSummary) => number> = {
    // The latest trouble first.
    needsYou: (a, b) => lastAt(b) - lastAt(a) || byName(a, b),
    // What runs now, then by next run; one that never comes last.
    scheduled: (a, b) =>
        Number(b.group === 'running') - Number(a.group === 'running') ||
        (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) ||
        byName(a, b),
    new: byName,
    paused: byName,
};

/** The groups that have schedules, in the page's order. */
export function overviewGroups(schedules: readonly ScheduleSummary[]): OverviewGroup[] {
    return GROUP_ORDER.flatMap((id) => {
        const members = schedules.filter((schedule) => groupOf(schedule) === id);
        return members.length === 0 ? [] : [{id, schedules: [...members].sort(ORDER[id])}];
    });
}

/** The schedules J/K go through, top to bottom; Paused only while it is shown. */
export function overviewOrder(groups: readonly OverviewGroup[], showPaused: boolean): string[] {
    return groups
        .filter((group) => group.id !== 'paused' || showPaused)
        .flatMap((group) => group.schedules.map((schedule) => schedule.key));
}

/** The next key from `current` going `step`, staying at the ends; the first (or last) when nothing is chosen. */
export function stepKey(keys: readonly string[], current: string | null, step: 1 | -1): string | null {
    if (keys.length === 0) return null;
    const at = current === null ? -1 : keys.indexOf(current);
    if (at === -1) return step === 1 ? keys[0] : keys[keys.length - 1];
    return keys[Math.min(keys.length - 1, Math.max(0, at + step))];
}

// ── The header ──

/** The last segment of a project's path: what the page calls the project. */
export function projectName(projectPath: string): string {
    return projectPath.split('/').filter(Boolean).pop() ?? projectPath;
}

/** "7 schedules in 4 projects · 5 run tonight · Mac set to wake at 02:55 · week at 44%". */
export function headerLine(facts: ScheduleManagerFacts, now: number): string {
    const schedules = facts.schedules;
    const projects = new Set(schedules.map((schedule) => schedule.settings.projectPath)).size;
    const tonight = tonightWindow(now);
    const runTonight = schedules.filter(
        (schedule) =>
            schedule.settings.enabled &&
            schedule.nextRunAt !== null &&
            schedule.nextRunAt >= now &&
            schedule.nextRunAt < tonight.end,
    ).length;
    const parts = [
        `${schedules.length} ${schedules.length === 1 ? 'schedule' : 'schedules'} in ${projects} ${projects === 1 ? 'project' : 'projects'}`,
    ];
    if (runTonight > 0) parts.push(`${runTonight} ${runTonight === 1 ? 'runs' : 'run'} tonight`);
    if (facts.wakeAt) parts.push(`Mac set to wake at ${facts.wakeAt}`);
    else if (facts.suggestedWakeAt) parts.push('Mac not set to wake');
    if (facts.week !== null) parts.push(`week at ${Math.round(facts.week)}%`);
    return parts.join(' · ');
}

/** The wake to offer ("Wake the Mac at 02:55"): the suggested one, while the Mac is not set to it. */
export function wakeOffer(facts: Pick<ScheduleManagerFacts, 'wakeAt' | 'suggestedWakeAt'>): string | null {
    if (!facts.suggestedWakeAt || facts.wakeAt === facts.suggestedWakeAt) return null;
    return facts.suggestedWakeAt;
}

// ── A schedule and its runs ──

/** "this Mac", "VM devbox". */
export function runsOnText(runsOn: ScheduleRunsOn): string {
    return runsOn.kind === 'mac' ? 'this Mac' : `VM ${runsOn.host}`;
}

export type PillTone = 'failed' | 'late' | 'missed' | 'done' | 'skipped' | 'running';

/**
 * A run's pill where it asks for a look: TIME LIMIT, FAILED, MISSED, CAUGHT
 * UP LATE; RUNNING while it goes. A plain done or skipped run has none.
 */
export function runPill(run: Pick<ScheduleRun, 'status' | 'trigger'>): {text: string; tone: PillTone} | null {
    switch (run.status) {
        case 'limit':
            return {text: 'TIME LIMIT', tone: 'failed'};
        case 'failed':
            return {text: 'FAILED', tone: 'failed'};
        case 'missed':
            return {text: 'MISSED', tone: 'missed'};
        case 'running':
            return {text: 'RUNNING', tone: 'running'};
        case 'done':
            return run.trigger === 'catch-up' ? {text: 'CAUGHT UP LATE', tone: 'late'} : null;
        case 'skipped':
            return null;
    }
}

/** A run's status in a word or two, for its row: "done", "caught up", "time limit". */
export function statusWord(run: Pick<ScheduleRun, 'status' | 'trigger'>): string {
    const words: Record<RunStatus, string> = {
        running: 'running',
        done: 'done',
        failed: 'failed',
        limit: 'time limit',
        skipped: 'skipped',
        missed: 'missed',
    };
    return run.status === 'done' && run.trigger === 'catch-up' ? 'caught up' : words[run.status];
}

/** A report's first line, cut to `max` characters: what a compact row says of its last run. */
export function reportLine(report: string | null, max = 48): string | null {
    const line = report
        ?.split('\n')
        .map((part) => part.replace(/^[\s#>*\-–•✓]+/, '').trim())
        .find((part) => part.length > 0);
    if (!line) return null;
    return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

/** A compact row's right side: "running now, 6 min in", or "tonight 03:20 · nothing new". */
export function rowSideText(schedule: ScheduleSummary, now: number): string {
    const last = schedule.last;
    if (last?.status === 'running') {
        const minutes = runMinutes(last, now);
        return minutes === null ? 'running now' : `running now, ${Math.max(1, Math.round(minutes))} min in`;
    }
    const parts: string[] = [];
    if (schedule.settings.enabled && schedule.nextRunAt !== null) parts.push(nextRunText(schedule.nextRunAt, now));
    const said = reportLine(last?.report ?? null, 28);
    if (said) parts.push(said);
    else if (last && last.status !== 'done') parts.push(statusWord(last));
    return parts.join(' · ') || 'not run yet';
}

/** The schedule file relative to its project, and the slash command it also is. */
export function scheduleFile(key: string, projectPath: string): {readonly path: string; readonly command: string} {
    const root = projectPath.endsWith('/') ? projectPath : projectPath + '/';
    const path = key.startsWith(root) ? key.slice(root.length) : key;
    const file = key.split('/').pop() ?? key;
    return {path, command: '/' + file.replace(/\.md$/, '')};
}

// ── The figure ──

/** Matches the Schedule manager's states in @jblaak/patch 0.13. */
export type ScheduleFigurePose = 'calm' | 'running' | 'needsYou';

export interface ScheduleFigure {
    readonly pose: ScheduleFigurePose;
    /** Schedules that need the user. */
    readonly count: number;
}

/** Running while a run goes; Needs you while any schedule does; calm otherwise. The count is Needs you's. */
export function scheduleFigureOf(facts: ScheduleManagerFacts | null): ScheduleFigure {
    if (!facts) return {pose: 'calm', count: 0};
    const count = facts.schedules.filter((schedule) => schedule.group === 'needsYou').length;
    const running =
        facts.schedules.some((schedule) => schedule.group === 'running') ||
        facts.recentRuns.some((run) => run.status === 'running');
    return {pose: running ? 'running' : count > 0 ? 'needsYou' : 'calm', count};
}
