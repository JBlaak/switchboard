/**
 * The Schedule manager in the renderer: the overview main last pushed, which
 * the page, the Automatic shelf and the figure on the empty screen all read,
 * and the page's own state: which schedule's page is open and its detail,
 * the row or run chosen and the run unfolded, the prompt being edited, the
 * settings being edited, what is busy and the notice.
 */
import type {ScheduleDetail, ScheduleManagerFacts, ScheduleSettings} from '../../domain/schedule/manager';
import type {RendererEvent} from './events';

/** `scheduleManagerChanged`, what main pushes, is a push event in `events.ts`. */
export type ScheduleManagerEvent =
    /** The page asked for: its figure, its shortcut, a shelf link, a run row. `key` opens that schedule's page. */
    | {type: 'scheduleManagerPageRequested'; key: string | null}
    /** Esc on the overview. */
    | {type: 'scheduleManagerPageClosed'}
    /**
     * The create form asked for: N or New schedule on the page, or Make this a
     * schedule from a session (`sessionId`, drafted from what it did).
     */
    | {type: 'scheduleCreateRequested'; sessionId: string | null}
    /** A schedule's page read from main; `detail` null when its file is gone. */
    | {type: 'scheduleDetailLoaded'; key: string; detail: ScheduleDetail | null}
    /** J/K or a click on the overview. */
    | {type: 'scheduleRowSelected'; key: string | null}
    /** J/K or a click on a schedule's page: a run chosen. */
    | {type: 'scheduleRunSelected'; runId: string | null}
    /** ⏎ or a click on a run: unfolded, or folded again. `open` forces it. */
    | {type: 'scheduleRunToggled'; runId: string; open?: boolean}
    /** Paused shown or folded away. */
    | {type: 'schedulePausedShown'; shown: boolean}
    /** The prompt typed into (`text`), or an old version loaded into it from the history. */
    | {type: 'schedulePromptTyped'; text: string}
    | {type: 'schedulePromptNoteTyped'; note: string}
    /** Save or the page closed: the editor shows the saved prompt again. */
    | {type: 'schedulePromptReset'}
    /** The settings sheet: opened on the schedule's settings, edited, closed. */
    | {type: 'scheduleSettingsOpened'; settings: ScheduleSettings}
    | {type: 'scheduleSettingsEdited'; settings: ScheduleSettings}
    | {type: 'scheduleSettingsClosed'}
    /** An action going (`what`), or done (null). */
    | {type: 'scheduleManagerBusy'; what: string | null}
    | {type: 'scheduleManagerNoticed'; notice: string | null};

export interface ScheduleManagerPageState {
    /** The schedule whose page is open; null on the overview. */
    readonly openKey: string | null;
    /** Its detail, once main answered for it. */
    readonly detail: ScheduleDetail | null;
    /** The overview's chosen schedule. */
    readonly selected: string | null;
    /** The schedule page's chosen run, and the one unfolded. */
    readonly selectedRun: string | null;
    readonly expandedRun: string | null;
    readonly showPaused: boolean;
    /** The prompt as typed; null while it is the saved one. */
    readonly promptDraft: string | null;
    readonly promptNote: string;
    /** The settings sheet's copy while it is open. */
    readonly settingsDraft: ScheduleSettings | null;
    /** What is being done: `save`, `runNow`, `enable`, `skip`, `wake`, `tune`, …; null when nothing is. */
    readonly busy: string | null;
    readonly notice: string | null;
}

export interface ScheduleManagerSliceState {
    /** Null until main first answers. */
    readonly facts: ScheduleManagerFacts | null;
    readonly page: ScheduleManagerPageState;
}

export const initialScheduleManagerPage: ScheduleManagerPageState = {
    openKey: null,
    detail: null,
    selected: null,
    selectedRun: null,
    expandedRun: null,
    showPaused: false,
    promptDraft: null,
    promptNote: '',
    settingsDraft: null,
    busy: null,
    notice: null,
};

export const initialScheduleManagerState: ScheduleManagerSliceState = {facts: null, page: initialScheduleManagerPage};

export function scheduleManagerReducer(
    state: ScheduleManagerSliceState,
    event: RendererEvent,
): ScheduleManagerSliceState {
    switch (event.type) {
        case 'scheduleManagerChanged':
            return {...state, facts: event.facts};
        default: {
            const page = pageReducer(state.page, event);
            return page === state.page ? state : {...state, page};
        }
    }
}

/** Leaving a schedule's page drops what was typed on it. */
const LEFT: Partial<ScheduleManagerPageState> = {
    detail: null,
    selectedRun: null,
    expandedRun: null,
    promptDraft: null,
    promptNote: '',
    settingsDraft: null,
    notice: null,
};

function pageReducer(page: ScheduleManagerPageState, event: RendererEvent): ScheduleManagerPageState {
    switch (event.type) {
        case 'scheduleManagerPageRequested':
            if (event.key === page.openKey) return page;
            // Back on the overview, the schedule just left stays chosen.
            return event.key === null
                ? {...page, ...LEFT, openKey: null, selected: page.openKey ?? page.selected}
                : {...page, ...LEFT, openKey: event.key, selected: event.key};

        case 'scheduleManagerPageClosed':
            return page.openKey === null && page.notice === null ? page : {...page, ...LEFT, openKey: null};

        case 'scheduleDetailLoaded': {
            if (event.key !== page.openKey) return page;
            const runs = event.detail?.runs ?? [];
            // A chosen run that is gone is let go.
            const keep = (id: string | null) => (id && runs.some((run) => run.id === id) ? id : null);
            return {
                ...page,
                detail: event.detail,
                selectedRun: keep(page.selectedRun) ?? runs[0]?.id ?? null,
                expandedRun: keep(page.expandedRun),
            };
        }

        case 'scheduleRowSelected':
            return {...page, selected: event.key};

        case 'scheduleRunSelected':
            return {...page, selectedRun: event.runId};

        case 'scheduleRunToggled': {
            const open = event.open ?? page.expandedRun !== event.runId;
            return {...page, selectedRun: event.runId, expandedRun: open ? event.runId : null};
        }

        case 'schedulePausedShown':
            return {...page, showPaused: event.shown};

        case 'schedulePromptTyped':
            return {...page, promptDraft: event.text};

        case 'schedulePromptNoteTyped':
            return {...page, promptNote: event.note};

        case 'schedulePromptReset':
            return {...page, promptDraft: null, promptNote: ''};

        case 'scheduleSettingsOpened':
        case 'scheduleSettingsEdited':
            return {...page, settingsDraft: event.settings};

        case 'scheduleSettingsClosed':
            return {...page, settingsDraft: null};

        case 'scheduleManagerBusy':
            return {...page, busy: event.what};

        case 'scheduleManagerNoticed':
            return {...page, notice: event.notice};

        default:
            return page;
    }
}

/** The prompt the editor shows: the one typed, or the saved one. */
export function promptShown(page: ScheduleManagerPageState): string {
    return page.promptDraft ?? page.detail?.summary.settings.prompt ?? '';
}

/** Whether the editor holds something other than the saved prompt. */
export function promptEdited(page: ScheduleManagerPageState): boolean {
    return page.promptDraft !== null && page.promptDraft !== (page.detail?.summary.settings.prompt ?? '');
}
