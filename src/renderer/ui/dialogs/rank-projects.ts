/**
 * The project picker's filter: which projects match a query, in what order,
 * and which characters of each name to pick out.
 *
 * Pure, so the rules run under the node test runner without a DOM.
 */
import {fuzzyMatch} from '../../../domain/search/fuzzy';
import {projectLabel} from '../../features/sessions/project-label';
import {byRecency} from '../../../domain/project/project-recency';
import type {Project} from '../../../domain/project/project';
import type {SessionRecency} from '../../../domain/project/project-recency';

/** One filtered project, with what the ranking used to get there. */
export interface Candidate {
    project: Project;
    label: string;
    /** The short label matched, rather than only the full path. */
    onLabel: boolean;
    score: number;
    /** Matched positions in the label; empty for a match on the path alone. */
    positions: number[];
}

/**
 * Rank the projects against the query.
 *
 * Anything the *label* matched comes first, however well a long path happened
 * to score — "sb" means switchboard, not the /Users/…/website whose path
 * happens to contain an s before a b. Then the project with the most recent
 * session (see `sessionRecency`), with or without a query, and only then the
 * better score.
 */
export function rankProjects(projects: readonly Project[], query: string, recency: SessionRecency): Candidate[] {
    const matches: Candidate[] = [];

    for (const project of projects) {
        const label = projectLabel(project.projectPath);
        const labelMatch = fuzzyMatch(query, label);
        const match = labelMatch || fuzzyMatch(query, project.projectPath);
        if (!match) continue;
        matches.push({
            project,
            label,
            onLabel: !!labelMatch,
            score: match.score,
            positions: labelMatch ? match.positions : [],
        });
    }

    const mostRecent = byRecency(recency, (candidate: Candidate) => candidate.project.projectPath);
    matches.sort((a, b) => Number(b.onLabel) - Number(a.onLabel) || mostRecent(a, b) || b.score - a.score);

    return matches;
}

/** A stretch of a label, highlighted or not. */
export interface LabelRun {
    text: string;
    matched: boolean;
}

/**
 * Split a label into plain and matched runs.
 *
 * Runs are coalesced, so a contiguous match is one highlight rather than one
 * per character.
 */
export function labelRuns(label: string, positions: readonly number[]): LabelRun[] {
    if (positions.length === 0) return [{text: label, matched: false}];

    const matched = new Set(positions);
    const runs: LabelRun[] = [];
    let i = 0;
    while (i < label.length) {
        const isMatch = matched.has(i);
        let j = i + 1;
        while (j < label.length && matched.has(j) === isMatch) j++;
        runs.push({text: label.slice(i, j), matched: isMatch});
        i = j;
    }
    return runs;
}
