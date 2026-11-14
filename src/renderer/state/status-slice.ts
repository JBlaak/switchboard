/**
 * The footer's status line: the transient activity line the main process
 * writes into while it indexes.
 *
 * The running count beside it is not kept here: the footer reads
 * `view.activePtyIds` live, so it follows the poll.
 */
import type {RendererEvent} from './events';

export interface StatusActivity {
    readonly text: string;
    /** A finished message, shown in its own colour and cleared after a linger. */
    readonly done: boolean;
}

export interface StatusState {
    readonly activity: StatusActivity;
}

const NO_ACTIVITY: StatusActivity = {text: '', done: false};

export const initialStatusState: StatusState = {activity: NO_ACTIVITY};

export function statusReducer(state: StatusState, event: RendererEvent): StatusState {
    switch (event.type) {
        // Whatever arrives replaces what is there; an empty message clears it.
        case 'statusUpdate': {
            const activity = event.text ? {text: event.text, done: event.kind === 'done'} : NO_ACTIVITY;
            if (activity.text === state.activity.text && activity.done === state.activity.done) return state;
            return {...state, activity};
        }

        // Only a done message lingers; anything newer has already replaced it.
        case 'statusActivityExpired':
            return state.activity.done ? {...state, activity: NO_ACTIVITY} : state;

        default:
            return state;
    }
}
