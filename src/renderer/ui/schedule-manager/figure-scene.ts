/**
 * The Schedule manager's Patch (`kind: 'schedule'`, calm, running and needs
 * you): its scene for `@jblaak/patch`, posed by the facts (`scheduleFigureOf`).
 */
import type {ManagerScene} from '@jblaak/patch';
import type {ScheduleFigure} from '../../../domain/schedule/page-view';

export function scheduleScene(figure: ScheduleFigure, label?: string): ManagerScene {
    return {kind: 'schedule', state: figure.pose, count: figure.count, ...(label === undefined ? {} : {label})};
}

export function sameScheduleFigure(a: ScheduleFigure, b: ScheduleFigure): boolean {
    return a.pose === b.pose && a.count === b.count;
}
