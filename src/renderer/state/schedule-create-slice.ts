/**
 * The create-a-schedule dialog: two steps, Describe it and Review the draft.
 *
 * Opened by `scheduleCreateRequested` (N on the Schedule manager, New
 * schedule, or Make this a schedule from a session); which dialog is on
 * screen is the dialog slice's, what this one shows is here.
 *
 * - Describe it: one sentence and a project, then Draft it (Claude writes the
 *   settings, 10–30 s), Write it myself (a blank form) or a copy of a
 *   schedule (its form, under a new name).
 * - Drafted from a session: step 1 is skipped; Claude drafts from what the
 *   session did as the dialog opens.
 * - Review the draft: the settings as a form, saved (and tried) from there.
 *
 * Every opening counts a `request`; a draft or a save answering an earlier
 * opening is dropped, so closing the dialog while Claude drafts and opening it
 * again never shows the old draft.
 */
import type {ScheduleDraftResult, ScheduleSaveResult, ScheduleSettings} from '../../domain/schedule/manager';
import type {RendererEvent} from './events';

export type ScheduleCreateEvent =
    | {type: 'scheduleCreateSentenceTyped'; text: string}
    | {type: 'scheduleCreateProjectPicked'; projectPath: string}
    /** Draft it, from the sentence; or the session's draft asked as the dialog opened. */
    | {type: 'scheduleCreateDraftAsked'}
    | {type: 'scheduleCreateDrafted'; request: number; result: ScheduleDraftResult}
    /** Write it myself, or a copy of a schedule: straight to the form, with no reason for the time. */
    | {type: 'scheduleCreateReviewOpened'; settings: ScheduleSettings}
    | {type: 'scheduleCreateSettingsEdited'; settings: ScheduleSettings}
    /** Back to the sentence from the form. */
    | {type: 'scheduleCreateBack'}
    | {type: 'scheduleCreateSaveAsked'}
    | {type: 'scheduleCreateSaved'; request: number; result: ScheduleSaveResult};

export type ScheduleCreateStep = 'describe' | 'review';

export interface ScheduleCreateState {
    /** Counts openings: the one an answer belongs to. */
    readonly request: number;
    readonly step: ScheduleCreateStep;
    /** The session being made a schedule, while its draft is asked for or failed; null otherwise. */
    readonly fromSession: string | null;
    readonly sentence: string;
    /** The project picked in step 1; null until one is, so the dialog shows its default. */
    readonly projectPath: string | null;
    /** Waiting on Claude's draft, or on the save. */
    readonly busy: 'drafting' | 'saving' | null;
    /** Why the last draft or save failed, shown in the step it failed in. */
    readonly error: string | null;
    /** The form's settings, in step 2. */
    readonly settings: ScheduleSettings | null;
    /** Why Claude picked that time, for a draft. */
    readonly whenReason: string | null;
}

export const initialScheduleCreateState: ScheduleCreateState = {
    request: 0,
    step: 'describe',
    fromSession: null,
    sentence: '',
    projectPath: null,
    busy: null,
    error: null,
    settings: null,
    whenReason: null,
};

export function scheduleCreateReducer(state: ScheduleCreateState, event: RendererEvent): ScheduleCreateState {
    switch (event.type) {
        case 'scheduleCreateRequested':
            return {
                ...initialScheduleCreateState,
                request: state.request + 1,
                fromSession: event.sessionId,
                busy: event.sessionId ? 'drafting' : null,
            };
        case 'scheduleCreateSentenceTyped':
            return {...state, sentence: event.text};
        case 'scheduleCreateProjectPicked':
            return {...state, projectPath: event.projectPath};
        case 'scheduleCreateDraftAsked':
            return state.busy || state.step !== 'describe' ? state : {...state, busy: 'drafting', error: null};
        case 'scheduleCreateDrafted':
            if (event.request !== state.request || state.busy !== 'drafting') return state;
            if ('error' in event.result) return {...state, busy: null, error: event.result.error};
            return {
                ...state,
                step: 'review',
                busy: null,
                error: null,
                settings: event.result.draft.settings,
                whenReason: event.result.draft.whenReason,
            };
        case 'scheduleCreateReviewOpened':
            return {
                ...state,
                step: 'review',
                fromSession: null,
                busy: null,
                error: null,
                settings: event.settings,
                whenReason: null,
            };
        case 'scheduleCreateSettingsEdited':
            return state.step === 'review' ? {...state, settings: event.settings} : state;
        case 'scheduleCreateBack':
            return state.step === 'review' && state.busy !== 'saving'
                ? {...state, step: 'describe', fromSession: null, error: null}
                : state;
        case 'scheduleCreateSaveAsked':
            return state.step === 'review' && !state.busy ? {...state, busy: 'saving', error: null} : state;
        case 'scheduleCreateSaved':
            if (event.request !== state.request || state.busy !== 'saving') return state;
            return {...state, busy: null, error: 'error' in event.result ? event.result.error : null};
        default:
            return state;
    }
}
