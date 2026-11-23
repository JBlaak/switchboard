/**
 * What the create-a-schedule dialog shows, from what it is given: the
 * starters, the projects it can save to, the copies it offers, the slug a
 * new name takes, and which sessions can be made a schedule.
 *
 * Pure, so the rules run under the node test runner without a DOM.
 */
import {isRemoteProjectPath} from '../../../domain/project/remote-target';
import {worktreeParentPath} from '../../../domain/project/project-path';
import {byRecency} from '../../../domain/project/project-recency';
import {scheduleSlug, uniqueSlug} from '../../../domain/schedule/form';
import {projectLabel} from '../../features/sessions/project-label';
import type {Project} from '../../../domain/project/project';
import type {SessionRecency} from '../../../domain/project/project-recency';
import type {ScheduleSettings, ScheduleSummary} from '../../../domain/schedule/manager';
import type {SessionRow} from '../../../domain/session/session';

/** The starters under the sentence: each fills it in, to be edited before drafting. */
export const SCHEDULE_STARTERS: readonly {readonly label: string; readonly sentence: string}[] = [
    {
        label: 'Bug sweep',
        sentence:
            'Every night, look at the new Bugsnag errors in this project and open a PR for the worst ones. At most 3.',
    },
    {
        label: 'Dependency bumps',
        sentence:
            'Every Monday at 06:00, update the outdated dependencies, run the tests, and open one PR with the bumps that pass.',
    },
    {
        label: 'Release notes',
        sentence: 'Every Friday at 16:00, write release notes from the PRs merged this week, as a draft PR.',
    },
];

/** A project a schedule can be saved to. */
export interface ProjectChoice {
    readonly path: string;
    readonly label: string;
}

/**
 * The local projects, most recently worked in first. Remote and VM projects
 * are left out (schedules there are moved, not made), and so are worktrees:
 * a schedule belongs to its repository.
 */
export function localProjectChoices(projects: readonly Project[], recency: SessionRecency): ProjectChoice[] {
    return projects
        .filter((project) => !project.remote && !isRemoteProjectPath(project.projectPath))
        .filter((project) => !worktreeParentPath(project.projectPath))
        .sort(byRecency(recency, (project) => project.projectPath))
        .map((project) => ({path: project.projectPath, label: projectLabel(project.projectPath)}));
}

/** The project step 1 starts on: the session on screen's repository when it is offered, else the first. */
export function defaultProjectPath(choices: readonly ProjectChoice[], onScreen: string | null): string | null {
    const repository = onScreen ? (worktreeParentPath(onScreen) ?? onScreen) : null;
    if (repository && choices.some((choice) => choice.path === repository)) return repository;
    return choices[0]?.path ?? null;
}

/** The "Copy of …" starters: one per schedule, by name. */
export function copyChoices(schedules: readonly ScheduleSummary[]): {key: string; label: string}[] {
    return schedules.map((schedule) => ({key: schedule.key, label: `Copy of ${schedule.settings.name}…`}));
}

/** The slugs the schedules in a project already have. */
export function takenSlugs(schedules: readonly ScheduleSummary[], projectPath: string): Set<string> {
    return new Set(
        schedules
            .filter((schedule) => schedule.settings.projectPath === projectPath)
            .map((schedule) => schedule.settings.slug),
    );
}

/**
 * The form's edit, for a schedule not saved yet: a new name takes its slug
 * along, free in its project. (A saved schedule keeps its file's slug.)
 */
export function withNewName(
    previous: ScheduleSettings,
    next: ScheduleSettings,
    taken: ReadonlySet<string>,
): ScheduleSettings {
    if (next.name === previous.name && next.slug) return next;
    return {...next, slug: uniqueSlug(scheduleSlug(next.name), taken)};
}

/** Whether a session can be made a schedule: a local Claude session in a project. */
export function canMakeSchedule(session: Pick<SessionRow, 'type' | 'projectPath'>): boolean {
    if (session.type === 'terminal' || session.type === 'remote') return false;
    return !!session.projectPath && !isRemoteProjectPath(session.projectPath);
}
