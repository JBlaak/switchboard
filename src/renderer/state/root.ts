/**
 * The renderer's whole state, and the one reducer over it.
 *
 * Each slice owns its own rules; this only hands every event to each of them
 * and keeps the old state object when none of them changed, so an event that
 * concerns nobody notifies nobody.
 */
import { activityReducer, initialActivityState } from './activity-slice';
import { initialQuestionsState, questionsReducer } from './questions-slice';
import { initialRemoteState, remoteReducer } from './remote-slice';
import { initialStatusState, statusReducer } from './status-slice';
import { initialUpdateState, updateReducer } from './update-slice';
import { initialUsageState, usageReducer } from './usage-slice';
import { initialViewState, viewReducer } from './view-slice';
import type { ActivityState } from './activity-slice';
import type { QuestionsState } from './questions-slice';
import type { RemoteState } from './remote-slice';
import type { RendererEvent } from './events';
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
    status: initialStatusState,
    update: initialUpdateState,
  };
}

export function rootReducer(state: RendererState, event: RendererEvent): RendererState {
  const view = viewReducer(state.view, event);
  // The session on screen *when the event arrived*: none of the activity
  // events move it, and a re-key does not touch activity.
  const activity = activityReducer(state.activity, event, state.view.activeSessionId);
  const questions = questionsReducer(state.questions, event);
  const remote = remoteReducer(state.remote, event);
  const usage = usageReducer(state.usage, event);
  const status = statusReducer(state.status, event);
  const update = updateReducer(state.update, event);

  if (view === state.view && activity === state.activity && questions === state.questions
    && remote === state.remote && usage === state.usage && status === state.status
    && update === state.update) {
    return state;
  }
  return { view, activity, questions, remote, usage, status, update };
}
