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
import { archiveUndoReducer, initialArchiveUndoState, rekeyArchiveUndo } from './archive-undo-slice';
import { askReducer, initialAskState } from './ask-slice';
import { answersReducer, followPending, initialAnswersState } from './answers-slice';
import { ciStatusReducer, initialCiStatusState, rekeyCiStatus } from './ci-status-slice';
import { dialogReducer, initialDialogState } from './dialog-slice';
import { initialKeysState, keysReducer, rekeyKeys } from './keys-slice';
import { initialQuestionsState, questionsReducer, rekeyQuestions } from './questions-slice';
import { initialRemoteState, rekeyRemote, remoteReducer } from './remote-slice';
import { initialSessionListState, sessionListReducer } from './session-list-slice';
import { initialSessionWorkState, rekeySessionWork, sessionWorkReducer } from './session-work-slice';
import { initialPlanState, planReducer, rekeyPlan } from './plan-slice';
import { highlightedSession, initialMainAreaState, mainAreaReducer, rekeyMainArea } from './main-area-slice';
import { initialProjectPageState, projectPageReducer } from './project-page-slice';
import { initialTasksState, tasksReducer } from './tasks-slice';
import { initialPhoneAccessState, phoneAccessReducer, rekeyPhoneAccess } from './phone-access-slice';
import { initialSettingsState, settingsReducer } from './settings-slice';
import { initialSessionTaskState, rekeySessionTask, sessionTaskReducer } from './session-task-slice';
import { initialStatusState, statusReducer } from './status-slice';
import { initialToolbarState, toolbarReducer } from './toolbar-slice';
import { initialUpdateState, updateReducer } from './update-slice';
import { initialTerminalState, rekeyTerminal, terminalReducer } from './terminal-slice';
import { initialUsageState, usageReducer } from './usage-slice';
import { initialViewState, rekeyView, viewReducer } from './view-slice';
import type { ActivityState } from './activity-slice';
import type { AnswersState } from './answers-slice';
import type { ArchiveUndoState } from './archive-undo-slice';
import type { AskState } from './ask-slice';
import type { CiStatusState } from './ci-status-slice';
import type { DialogState } from './dialog-slice';
import type { RendererEvent } from './events';
import type { KeysState } from './keys-slice';
import type { QuestionsState } from './questions-slice';
import type { RemoteState } from './remote-slice';
import type { SessionListState } from './session-list-slice';
import type { SessionWorkState } from './session-work-slice';
import type { PlanState } from './plan-slice';
import type { MainAreaState } from './main-area-slice';
import type { ProjectPageState } from './project-page-slice';
import type { TasksState } from './tasks-slice';
import type { PhoneAccessSliceState } from './phone-access-slice';
import type { SettingsState } from './settings-slice';
import type { SessionTaskState } from './session-task-slice';
import type { StatusState } from './status-slice';
import type { ToolbarState } from './toolbar-slice';
import type { UpdateState } from './update-slice';
import type { TerminalState } from './terminal-slice';
import type { UsageState } from './usage-slice';
import type { ViewState } from './view-slice';

export interface RendererState {
  readonly view: ViewState;
  readonly activity: ActivityState;
  readonly questions: QuestionsState;
  readonly answers: AnswersState;
  readonly remote: RemoteState;
  readonly usage: UsageState;
  readonly toolbar: ToolbarState;
  readonly dialog: DialogState;
  readonly settings: SettingsState;
  readonly keys: KeysState;
  readonly status: StatusState;
  readonly update: UpdateState;
  readonly sessionList: SessionListState;
  readonly terminal: TerminalState;
  readonly sessionWork: SessionWorkState;
  readonly plan: PlanState;
  readonly mainArea: MainAreaState;
  readonly projectPage: ProjectPageState;
  readonly tasks: TasksState;
  readonly ciStatus: CiStatusState;
  readonly ask: AskState;
  readonly phoneAccess: PhoneAccessSliceState;
  readonly sessionTask: SessionTaskState;
  readonly archiveUndo: ArchiveUndoState;
}

export function initialRendererState(activeSessionId: string | null = null): RendererState {
  return {
    view: initialViewState(activeSessionId),
    activity: initialActivityState,
    questions: initialQuestionsState,
    answers: initialAnswersState,
    remote: initialRemoteState,
    usage: initialUsageState,
    toolbar: initialToolbarState,
    dialog: initialDialogState,
    settings: initialSettingsState,
    keys: initialKeysState,
    status: initialStatusState,
    update: initialUpdateState,
    sessionList: initialSessionListState,
    terminal: initialTerminalState,
    sessionWork: initialSessionWorkState,
    plan: initialPlanState,
    mainArea: initialMainAreaState,
    projectPage: initialProjectPageState,
    tasks: initialTasksState,
    ciStatus: initialCiStatusState,
    ask: initialAskState,
    phoneAccess: initialPhoneAccessState,
    sessionTask: initialSessionTaskState,
    archiveUndo: initialArchiveUndoState,
  };
}

export function rootReducer(state: RendererState, event: RendererEvent): RendererState {
  if (event.type === 'sessionForked') return rekeyState(state, event.oldId, event.newId);

  const view = viewReducer(state.view, event);
  // The session on screen *when the event arrived*: none of the activity
  // events move it. Not the active session: one covered by a project or the
  // settings is not being looked at.
  const activity = activityReducer(state.activity, event, highlightedSession(state.mainArea));
  const questions = questionsReducer(state.questions, event);
  // The sets as this event left them, so an entry comes and goes with its set.
  const answers = answersReducer(state.answers, event, questions);
  const remote = remoteReducer(state.remote, event);
  const usage = usageReducer(state.usage, event);
  const keys = keysReducer(state.keys, event);
  const status = statusReducer(state.status, event);
  const update = updateReducer(state.update, event);
  const settings = settingsReducer(state.settings, event);
  const dialog = dialogReducer(state.dialog, event);
  const toolbar = toolbarReducer(state.toolbar, event);
  const sessionList = sessionListReducer(state.sessionList, event);
  const terminal = terminalReducer(state.terminal, event);
  const sessionWork = sessionWorkReducer(state.sessionWork, event);
  const plan = planReducer(state.plan, event);
  // Closing a page goes back to the active session as this event left it.
  const mainArea = mainAreaReducer(state.mainArea, event, view.activeSessionId);
  const projectPage = projectPageReducer(state.projectPage, event);
  const tasks = tasksReducer(state.tasks, event);
  const ciStatus = ciStatusReducer(state.ciStatus, event);
  const ask = askReducer(state.ask, event);
  const phoneAccess = phoneAccessReducer(state.phoneAccess, event);
  // Link task… follows the BlaakTasks switch as this event left it.
  const sessionTask = sessionTaskReducer(state.sessionTask, event, tasks.enabled);
  const archiveUndo = archiveUndoReducer(state.archiveUndo, event);

  return settle(state, {
    view, activity, questions, answers, remote, usage, keys, status, update, settings, dialog, toolbar,
    terminal, sessionList, sessionWork, plan, mainArea, projectPage, tasks, ciStatus, ask, phoneAccess, sessionTask, archiveUndo,
  });
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
  const questions = rekeyQuestions(state.questions, oldId, newId);
  return settle(state, {
    view: rekeyView(state.view, oldId, newId),
    activity: rekeyActivity(state.activity, oldId, newId),
    questions,
    // Keyed by tool-use id, so nothing moves; a set the re-key dropped loses its entry.
    answers: followPending(state.answers, questions),
    remote: rekeyRemote(state.remote, oldId, newId),
    usage: state.usage,
    keys: rekeyKeys(state.keys, oldId, newId),
    status: state.status,
    update: state.update,
    settings: state.settings,
    dialog: state.dialog,
    toolbar: state.toolbar,
    terminal: rekeyTerminal(state.terminal, oldId, newId),
    // Keyed by element ids, which a re-key leaves alone (see `session-list-slice`).
    sessionList: state.sessionList,
    sessionWork: rekeySessionWork(state.sessionWork, oldId, newId),
    plan: rekeyPlan(state.plan, oldId, newId),
    // The session on screen keeps the main area under its new id.
    mainArea: rekeyMainArea(state.mainArea, oldId, newId),
    // Keyed by project path and row ids, which a re-key leaves alone.
    projectPage: state.projectPage,
    // Keyed by task id; a detail's sessions are asked again as it opens.
    tasks: state.tasks,
    ciStatus: rekeyCiStatus(state.ciStatus, oldId, newId),
    // The box on the empty screen belongs to no session.
    ask: state.ask,
    // A re-keyed session stays on the phone it was on.
    phoneAccess: rekeyPhoneAccess(state.phoneAccess, oldId, newId),
    // A re-keyed session keeps its task.
    sessionTask: rekeySessionTask(state.sessionTask, oldId, newId),
    // An archive taken back brings the session back under its new id.
    archiveUndo: rekeyArchiveUndo(state.archiveUndo, oldId, newId),
  });
}

/** `state` itself when no slice changed, so nobody is told about nothing. */
function settle(state: RendererState, next: RendererState): RendererState {
  for (const key of Object.keys(next) as (keyof RendererState)[]) {
    if (next[key] !== state[key]) return next;
  }
  return state;
}
