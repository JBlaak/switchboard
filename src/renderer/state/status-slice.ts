/**
 * The footer's status line: a standing count of running sessions and a
 * transient activity line the main process writes into while it indexes.
 *
 * The count is a snapshot, not a live reading of `view.activePtyIds`: it is
 * taken when the project list has loaded (`runningCounted`) and stays as it
 * was until the next one, which is how the footer has always behaved. The
 * poll updates `activePtyIds` every few seconds; the footer does not follow it.
 */
import type { RendererEvent } from './events';

export interface StatusActivity {
  readonly text: string;
  /** A finished message, shown in its own colour and cleared after a linger. */
  readonly done: boolean;
}

export interface StatusState {
  /** Sessions running when the list last loaded. */
  readonly running: number;
  readonly activity: StatusActivity;
}

const NO_ACTIVITY: StatusActivity = { text: '', done: false };

export const initialStatusState: StatusState = { running: 0, activity: NO_ACTIVITY };

export function statusReducer(state: StatusState, event: RendererEvent): StatusState {
  switch (event.type) {
    case 'runningCounted':
      return state.running === event.running ? state : { ...state, running: event.running };

    // Whatever arrives replaces what is there; an empty message clears it.
    case 'statusUpdate': {
      const activity = event.text ? { text: event.text, done: event.kind === 'done' } : NO_ACTIVITY;
      if (activity.text === state.activity.text && activity.done === state.activity.done) return state;
      return { ...state, activity };
    }

    // Only a done message lingers; anything newer has already replaced it.
    case 'statusActivityExpired':
      return state.activity.done ? { ...state, activity: NO_ACTIVITY } : state;

    default:
      return state;
  }
}
