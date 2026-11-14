/**
 * Quick Ask's project search: the pop-up searches your local projects first,
 * and only once nothing matches does Enter go to Patch.
 *
 * A match has to be a proper one, since a sentence for Patch must fall
 * through: the whole query, spaces, dashes and case left out, is part of the
 * project's folder name. "switchb" and "Switch Board" find `switchboard`;
 * "fix the switchboard login" finds nothing and goes to Patch.
 *
 * Pure, so the rule runs under the node test runner.
 */

/** A project the pop-up can search, in the order it is offered: most recently worked in first. */
export interface ProjectHit {
    readonly projectPath: string;
    readonly folder: string;
}

/** How many matches the pop-up lists. */
export const MAX_PROJECT_HITS = 6;

/**
 * The projects `query` properly matches: those whose folder starts with it
 * first, then those that hold it further in, each in the order given.
 * Nothing for an empty query.
 */
export function searchProjects(projects: readonly ProjectHit[], query: string): ProjectHit[] {
    const needle = squash(query);
    if (!needle) return [];
    const starts: ProjectHit[] = [];
    const holds: ProjectHit[] = [];
    for (const project of projects) {
        const at = squash(project.folder).indexOf(needle);
        if (at === 0) starts.push(project);
        else if (at > 0) holds.push(project);
    }
    return [...starts, ...holds].slice(0, MAX_PROJECT_HITS);
}

/** Lower case, letters and digits only, so separators and case don't decide a match. */
function squash(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
