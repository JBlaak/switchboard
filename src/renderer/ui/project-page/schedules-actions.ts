/**
 * Where a project's schedules run (#276 stage 5, Q18): asking main for a
 * page's project (a local one, or a copy), and moving them from the Schedules
 * line. The components and the hand-off actions call these, never
 * `window.api` or the store.
 *
 * A failed call is answered by main as `{ ok: false, error }` in place of
 * what was asked, so each answer is checked for its shape before it is kept.
 */
import {dispatch} from '../../state/app-store';
import {runOnTarget} from './schedules-view';
import type {ScheduleLocation} from '../../../application/services/vm-schedules';

/** Where the page's project runs its schedules: a local project's, or a copy's. */
export async function loadSchedules(projectPath: string): Promise<void> {
    const location: unknown = await window.api.schedulesWhere(projectPath).catch(() => null);
    dispatch({type: 'schedulesLoaded', projectPath, location: isLocation(location) ? location : null});
}

/**
 * The Schedules line's picker: run the local project's schedules on the Mac
 * (`ON_MAC`) or in that copy. An error (the VM couldn't be reached) leaves
 * them where they were, and says so.
 */
export async function moveSchedules(projectPath: string, localPath: string, value: string): Promise<void> {
    dispatch({type: 'schedulesMoving', projectPath});
    const answer: unknown = await window.api
        .runSchedulesOn(localPath, runOnTarget(value))
        .catch((err: Error) => ({error: err.message}));
    dispatch({
        type: 'schedulesMoved',
        projectPath,
        answer: isLocation(answer) ? answer : {error: errorOf(answer) || 'Couldn’t reach the VM'},
    });
}

// ── Shapes ──

function errorOf(value: unknown): string {
    const error = value && typeof value === 'object' ? (value as {error?: unknown}).error : undefined;
    return typeof error === 'string' ? error : '';
}

function isLocation(value: unknown): value is ScheduleLocation {
    if (!value || typeof value !== 'object') return false;
    const location = value as Record<string, unknown>;
    const runsOn = location.runsOn as Record<string, unknown> | null | undefined;
    return (
        typeof location.localPath === 'string' &&
        typeof location.count === 'number' &&
        !!runsOn &&
        typeof runsOn === 'object' &&
        (runsOn.kind === 'mac' || (runsOn.kind === 'vm' && typeof runsOn.copyPath === 'string'))
    );
}
