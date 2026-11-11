/**
 * How recently each project was worked in, for the project pickers: the Mac's
 * Projects modal and the phone's Ask Patch list.
 *
 * Recency is the newest session Switchboard has recorded for the project,
 * archived ones included — archiving a session tidies the list, it does not
 * mean the project was not just used. A repository also counts the sessions of
 * its worktrees, which the Mac picker lists under it.
 *
 * Pure, so the rules run under the node test runner.
 */
import {worktreeParentPath} from './project-path';
import type {Project} from './project';

/** Project path → epoch ms of its newest session; a project with none is left out. */
export type SessionRecency = ReadonlyMap<string, number>;

/**
 * Each project's newest session.
 *
 * Pass the list built with archived sessions included, so they count.
 */
export function sessionRecency(projects: readonly Project[]): SessionRecency {
    const recency = new Map<string, number>();
    const bump = (projectPath: string, at: number): void => {
        if (at > (recency.get(projectPath) ?? 0)) recency.set(projectPath, at);
    };
    for (const project of projects) {
        const at = newestSession(project);
        if (at === 0) continue;
        bump(project.projectPath, at);
        const parent = worktreeParentPath(project.projectPath);
        if (parent) bump(parent, at);
    }
    return recency;
}

/** Most recently worked in first; projects with no sessions keep their order, last. */
export function byRecency<T>(recency: SessionRecency, pathOf: (item: T) => string): (a: T, b: T) => number {
    return (a, b) => (recency.get(pathOf(b)) ?? 0) - (recency.get(pathOf(a)) ?? 0);
}

function newestSession(project: Project): number {
    let newest = 0;
    for (const session of project.sessions) {
        const at = new Date(session.modified).getTime();
        if (at > newest) newest = at;
    }
    return newest;
}
