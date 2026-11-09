/**
 * The last full overview of each project page (#172), kept in localStorage so
 * a page that opens again shows it at once, while main is asked for a fresh
 * one (`ui/project-page/install-project-page` reads and writes it).
 *
 * One JSON record under one key: the newest first, one per project and its
 * Show closed and Show merged, at most `STORED_OVERVIEWS_KEPT` of them and
 * no more than `STORED_OVERVIEWS_BUDGET` characters, the oldest dropped
 * first. Only full answers from main are kept: not one without plans, not a
 * stale one, not an ssh project's.
 *
 * Which sessions run changes by the second, so a stored answer never says:
 * every running id is left out of it, as it is written and as it is read.
 *
 * Pure, so it is tested in node.
 */
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import type {ProjectOverview} from '../../domain/project/overview';

/** How many overviews are kept, across projects. */
export const STORED_OVERVIEWS_KEPT = 20;

/** How long the stored record may get, in characters: well within what localStorage holds. */
export const STORED_OVERVIEWS_BUDGET = 2_000_000;

/**
 * The record's shape; a record of another version is not read. Raise it
 * whenever `ProjectOverview` gains a field the page reads: a stored overview
 * without it reaches the page as it opens, and the throw takes down the window.
 * 2: pull requests carry their wait reads (#332).
 */
const VERSION = 2;

/** One project's last full overview, and what it was asked with. */
export interface StoredOverview {
    readonly overview: ProjectOverview;
    readonly closed: boolean;
    readonly merged: boolean;
}

/** The stored overviews, newest first; none when there are none or the record is not ours. */
export function parseStoredOverviews(stored: string | null): StoredOverview[] {
    if (!stored) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return [];
    }
    if (!parsed || typeof parsed !== 'object') return [];
    const {v, entries} = parsed as {v?: unknown; entries?: unknown};
    if (v !== VERSION || !Array.isArray(entries)) return [];
    return entries.filter(
        (entry): entry is StoredOverview =>
            !!entry &&
            typeof entry === 'object' &&
            typeof entry.closed === 'boolean' &&
            typeof entry.merged === 'boolean' &&
            !!entry.overview &&
            typeof entry.overview.projectPath === 'string' &&
            Array.isArray(entry.overview.worktrees),
    );
}

/** `projectPath`'s stored overview asked with `closed` and `merged`, with nothing running; null when none is. */
export function storedOverviewFor(
    stored: readonly StoredOverview[],
    projectPath: string,
    closed: boolean,
    merged: boolean,
): StoredOverview | null {
    const found = stored.find(
        (entry) => entry.overview.projectPath === projectPath && entry.closed === closed && entry.merged === merged,
    );
    return found ? {...found, overview: withoutRunning(found.overview)} : null;
}

/**
 * Whether `overview` is one to keep: a full, fresh answer for a local project,
 * or (#276 stage 4) for a VM project (`vm`), whose page then opens as fast.
 * Being a VM project is decisive: its overview may still say `remote`. An
 * agentless remote's has nothing to keep.
 */
export function isStorable(overview: ProjectOverview, vm = false): boolean {
    if (!vm && (overview.remote || isRemoteProjectPath(overview.projectPath))) return false;
    const github = overview.github;
    return github === null || (github.ok && !github.stale && !github.plansPending);
}

/**
 * The record to write with `entry` in it, newest first: in place of the one
 * for the same project and options, the oldest dropped past
 * `STORED_OVERVIEWS_KEPT` or the budget.
 */
export function storedOverviewsWith(stored: readonly StoredOverview[], entry: StoredOverview): string {
    const same = (other: StoredOverview): boolean =>
        other.overview.projectPath === entry.overview.projectPath &&
        other.closed === entry.closed &&
        other.merged === entry.merged;
    let entries = [
        {...entry, overview: withoutRunning(entry.overview)},
        ...stored.filter((other) => !same(other)),
    ].slice(0, STORED_OVERVIEWS_KEPT);
    let record = JSON.stringify({v: VERSION, entries});
    while (record.length > STORED_OVERVIEWS_BUDGET && entries.length > 1) {
        entries = entries.slice(0, -1);
        record = JSON.stringify({v: VERSION, entries});
    }
    return record.length > STORED_OVERVIEWS_BUDGET ? JSON.stringify({v: VERSION, entries: []}) : record;
}

/**
 * `overview` with no session running: none in the project or its worktrees,
 * no issue row showing one (it shows its PR instead, if it has one), and no
 * plan counted as running.
 */
export function withoutRunning(overview: ProjectOverview): ProjectOverview {
    const github = overview.github;
    const quiet = <R extends {status: {kind: string} | null; pullRequest: unknown}>(row: R): R =>
        row.status?.kind === 'running'
            ? {...row, status: row.pullRequest ? {kind: 'pull-request', pullRequest: row.pullRequest} : null}
            : row;
    return {
        ...overview,
        running: [],
        worktrees: overview.worktrees.map((worktree) => ({...worktree, running: []})),
        github: github?.ok
            ? {
                  ...github,
                  plans: github.plans.map((plan) => ({...plan, running: false, issues: plan.issues.map(quiet)})),
                  loose: github.loose.map(quiet),
              }
            : github,
    };
}
