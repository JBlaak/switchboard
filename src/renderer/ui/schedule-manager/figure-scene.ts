/**
 * The Schedule manager's Patch: its scene for `@jblaak/patch`, posed by the
 * facts (`scheduleFigureOf`).
 *
 * Patch 0.13 adds the Schedule manager (`kind: 'schedule'`, calm, running and
 * needs you); until the app is on it, the figure is left out rather than
 * asked for art the package does not have.
 */
import {MANAGER_KINDS, type ManagerScene} from '@jblaak/patch';
import type {ScheduleFigure} from '../../../domain/schedule/page';

/** Whether this Patch draws the Schedule manager. TODO(patch 0.13): drop, it always does. */
export const SCHEDULE_FIGURE_DRAWN = (MANAGER_KINDS as readonly string[]).includes('schedule');

export function scheduleScene(figure: ScheduleFigure, label?: string): ManagerScene {
    const scene = {kind: 'schedule', state: figure.pose, count: figure.count, ...(label === undefined ? {} : {label})};
    // TODO(patch 0.13): drop the cast
    return scene as unknown as ManagerScene;
}

export function sameScheduleFigure(a: ScheduleFigure, b: ScheduleFigure): boolean {
    return a.pose === b.pose && a.count === b.count;
}
