/**
 * How far a plan is, in a few numbers: the level you are on and, per level,
 * how many issues it has, how many are closed, how many have a PR and how
 * many are ready to start. What a
 * pinned plan's row in the session list draws, without the whole plan.
 */
import {layOutPlan} from './layout';
import type {NodeState, Plan} from './model';

export interface LevelProgress {
    readonly total: number;
    /** Merged, closed or not planned. */
    readonly done: number;
    /** Open with a PR, draft or not, or a claimed wayfinder ticket. */
    readonly started: number;
    /** Open, unblocked and without a PR: ready to start. The rest are blocked. */
    readonly ready: number;
}

export interface PlanProgress {
    /** The 1-based level you are on (P3); null once the plan is cleared. */
    readonly current: number | null;
    /** Level 1 first. */
    readonly levels: readonly LevelProgress[];
}

const DONE: readonly NodeState[] = ['merged', 'closed', 'done', 'not-planned'];
const STARTED: readonly NodeState[] = ['review', 'draft', 'claimed'];

export function planProgress(plan: Plan): PlanProgress {
    const layout = layOutPlan(plan);
    return {
        current: layout.current,
        levels: layout.levels.map((row) => {
            const states = row.map((issue) => layout.stateOf(issue));
            return {
                total: states.length,
                done: states.filter((state) => DONE.includes(state)).length,
                started: states.filter((state) => STARTED.includes(state)).length,
                ready: states.filter((state) => state === 'ready').length,
            };
        }),
    };
}

/** Closed issues and all issues, across every level. */
export function progressCounts(progress: PlanProgress): {done: number; total: number} {
    return progress.levels.reduce((sum, level) => ({done: sum.done + level.done, total: sum.total + level.total}), {
        done: 0,
        total: 0,
    });
}

export function sameProgress(a: PlanProgress, b: PlanProgress): boolean {
    return (
        a.current === b.current &&
        a.levels.length === b.levels.length &&
        a.levels.every(
            (level, i) =>
                level.total === b.levels[i]!.total &&
                level.done === b.levels[i]!.done &&
                level.started === b.levels[i]!.started &&
                level.ready === b.levels[i]!.ready,
        )
    );
}
