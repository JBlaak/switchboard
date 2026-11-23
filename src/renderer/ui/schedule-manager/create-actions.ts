/**
 * What the create-a-schedule dialog does outside itself: ask Claude for a
 * draft, start the form blank or from a copy, and save.
 *
 * Each answer is dispatched with the opening it was asked for, so the slice
 * can drop one that comes back after the dialog was closed and opened again.
 */
import {dispatch, getState} from '../../state/app-store';
import {blankScheduleSettings, copyScheduleSettings} from '../../../domain/schedule/form';
import {openScheduleManager} from './actions';
import {takenSlugs} from './create-view';
import type {ScheduleDraftResult, ScheduleSaveResult, ScheduleSettings} from '../../../domain/schedule/manager';

/** Draft it: Claude writes a schedule from the sentence, in the project picked. */
export async function draftSchedule(sentence: string, projectPath: string): Promise<void> {
    if (!sentence.trim() || getState().scheduleCreate.busy) return;
    dispatch({type: 'scheduleCreateDraftAsked'});
    const {request} = getState().scheduleCreate;
    const result = await answered(window.api.scheduleManagerDraft(sentence.trim(), projectPath));
    dispatch({type: 'scheduleCreateDrafted', request, result});
}

/**
 * Claude drafts a schedule from what a session did. Asked as the dialog opens
 * (already waiting, see the slice), and again by Try again.
 */
export async function draftFromSession(sessionId: string): Promise<void> {
    if (getState().scheduleCreate.busy !== 'drafting') dispatch({type: 'scheduleCreateDraftAsked'});
    const {request} = getState().scheduleCreate;
    const result = await answered(window.api.scheduleManagerDraftFromSession(sessionId));
    dispatch({type: 'scheduleCreateDrafted', request, result});
}

/** Write it myself: the form, blank, in the project picked. */
export function writeScheduleYourself(projectPath: string): void {
    dispatch({type: 'scheduleCreateReviewOpened', settings: blankScheduleSettings(projectPath)});
}

/** Copy of a schedule: its form under a new name. */
export function copySchedule(key: string): void {
    const schedules = getState().scheduleManager.facts?.schedules ?? [];
    const source = schedules.find((schedule) => schedule.key === key);
    if (!source) return;
    const taken = takenSlugs(schedules, source.settings.projectPath);
    dispatch({type: 'scheduleCreateReviewOpened', settings: copyScheduleSettings(source.settings, taken)});
}

/**
 * Save the schedule, and with `runNow` try it once at once. Saved, the dialog
 * closes and the schedule's page opens; a failure stays on the form.
 */
export async function saveNewSchedule(settings: ScheduleSettings, runNow: boolean, close: () => void): Promise<void> {
    if (getState().scheduleCreate.busy) return;
    dispatch({type: 'scheduleCreateSaveAsked'});
    const {request} = getState().scheduleCreate;
    const result = await answered<ScheduleSaveResult>(window.api.scheduleManagerSave(null, settings, null, runNow));
    dispatch({type: 'scheduleCreateSaved', request, result});
    // Closed (or opened again) while it saved: the schedule is saved, the page is not forced open.
    const state = getState();
    if (!('key' in result) || state.scheduleCreate.request !== request || state.dialog.open?.kind !== 'createSchedule')
        return;
    close();
    openScheduleManager(result.key);
}

/** The schedules, for the Copy of… starters, when nothing has asked for them yet. */
export async function loadSchedulesForCopies(): Promise<void> {
    if (getState().scheduleManager.facts) return;
    try {
        const facts = await window.api.scheduleManagerFacts();
        if (facts && !getState().scheduleManager.facts) dispatch({type: 'scheduleManagerChanged', facts});
    } catch {
        // No copies to offer; the rest of the dialog does not need them.
    }
}

/** A call that failed outright, as the error the dialog shows. */
async function answered<T extends ScheduleDraftResult | ScheduleSaveResult>(
    call: Promise<T>,
): Promise<T | {error: string}> {
    try {
        return await call;
    } catch (err) {
        return {error: (err as Error).message || 'Something went wrong'};
    }
}
