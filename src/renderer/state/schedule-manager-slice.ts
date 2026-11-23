/**
 * The Schedule manager in the renderer: the overview main last pushed, which
 * the page, the Automatic shelf and the figure on the empty screen all read.
 *
 * The page's own state (the open schedule's detail, the create form, a
 * notice) is the page's to add here.
 */
import type {ScheduleManagerFacts} from '../../domain/schedule/manager';
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
    | {type: 'scheduleCreateRequested'; sessionId: string | null};

export interface ScheduleManagerSliceState {
    /** Null until main first answers. */
    readonly facts: ScheduleManagerFacts | null;
}

export const initialScheduleManagerState: ScheduleManagerSliceState = {facts: null};

export function scheduleManagerReducer(
    state: ScheduleManagerSliceState,
    event: RendererEvent,
): ScheduleManagerSliceState {
    switch (event.type) {
        case 'scheduleManagerChanged':
            return {...state, facts: event.facts};
        default:
            return state;
    }
}
