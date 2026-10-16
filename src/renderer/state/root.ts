/**
 * The renderer's whole state, and the one reducer over it.
 *
 * Each slice owns its own rules; this only hands every event to each of them
 * and keeps the old state object when none of them changed, so an event that
 * concerns nobody notifies nobody.
 *
 * The one exception is a re-key, which every slice keyed by session id has to
 * follow at once (see `rekeyState`).
 */
import { activityReducer, initialActivityState, rekeyActivity } from './activity-slice';
import { initialKeysState, keysReducer, rekeyKeys } from './keys-slice';
import { initialQuestionsState, questionsReducer, rekeyQuestions } from './questions-slice';
import { initialRemoteState, rekeyRemote, remoteReducer } from './remote-slice';
import { initialSettingsState, settingsReducer } from './settings-slice';
import { initialStatusState, statusReducer } from './status-slice';
import { initialUpdateState, updateReducer } from './update-slice';
import { initialUsageState, usageReducer } from './usage-slice';
import { initialViewState, rekeyView, viewReducer } from './view-slice';
import type { ActivityState } from './activity-slice';
import type { KeysState } from './keys-slice';
import type { QuestionsState } from './questions-slice';
import type { RemoteState } from './remote-slice';
import type { RendererEvent } from './events';
import type { SettingsState } from './settings-slice';
import type { StatusState } from './status-slice';
import type { UpdateState } from './update-slice';
import type { UsageState } from './usage-slice';
import type { ViewState } from './view-slice';

export interface RendererState {
  readonly view: ViewState;
  readonly activity: ActivityState;
  readonly questions: QuestionsState;
  readonly remote: RemoteState;
  readonly usage: UsageState;
  readonly settings: SettingsState;
  readonly keys: KeysState;
  readonly status: StatusState;
  readonly update: UpdateState;
}

export function initialRendererState(activeSessionId: string | null = null): RendererState {
  return {
    view: initialViewState(activeSessionId),
    activity: initialActivityState,
    questions: initialQuestionsState,
    remote: initialRemoteState,
    usage: initialUsageState,
    settings: initialSettingsState,
    keys: initialKeysState,
    status: initialStatusState,
    update: initialUpdateState,
  };
}

export function rootReducer(state: RendererState, event: RendererEvent): RendererState {
  if (event.type === 'sessionForked') return rekeyState(state, event.oldId, event.newId);

  const view = viewReducer(state.view, event);
  // The session on screen *when the event arrived*: none of the activity
  // events move it.
  const activity = activityReducer(state.activity, event, state.view.activeSessionId);
  const questions = questionsReducer(state.questions, event);
  const remote = remoteReducer(state.remote, event);
  const usage = usageReducer(state.usage, event);
  const keys = keysReducer(state.keys, event);
  const status = statusReducer(state.status, event);
  const update = updateReducer(state.update, event);
  const settings = settingsReducer(state.settings, event);

  return settle(state, { view, activity, questions, remote, usage, keys, status, update, settings });
}

/**
 * A fork or an accepted plan gave a running session a new id.
 *
 * Every slice keyed by session id moves in this one pass, so no subscriber
 * can ever see a state where some of them have moved and some have not, and
 * nothing is left behind under the old id. A slice added later that keys by
 * session id belongs here too. (Usage is per account, not per session.)
 *
 * The registries outside the store — the open terminals, the shared rows, the
 * write buffers — follow in `app/rekey-registries`, run by the IPC
 * follow-up for this same event.
 */
export function rekeyState(state: RendererState, oldId: string, newId: string): RendererState {
  if (oldId === newId) return state;
  return settle(state, {
    view: rekeyView(state.view, oldId, newId),
    activity: rekeyActivity(state.activity, oldId, newId),
    questions: rekeyQuestions(state.questions, oldId, newId),
    remote: rekeyRemote(state.remote, oldId, newId),
    usage: state.usage,
    keys: rekeyKeys(state.keys, oldId, newId),
    status: state.status,
    update: state.update,
    settings: state.settings,
  });
}

/** `state` itself when no slice changed, so nobody is told about nothing. */
function settle(state: RendererState, next: RendererState): RendererState {
  for (const key of Object.keys(next) as (keyof RendererState)[]) {
    if (next[key] !== state[key]) return next;
  }
  return state;
}
