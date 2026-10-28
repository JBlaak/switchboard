/**
 * What the main area shows (#168): exactly one of a session's terminal, a
 * session's work page, a project, the app settings, the Tasks page (#249), or
 * the empty screen.
 *
 * It is the one answer to "what is on screen", which is what the sidebar
 * highlight is derived from (`highlightedSession`). The active session id
 * (`view.activeSessionId`) is a different thing: the session to return to.
 * It stays set while a project or the settings cover it, so launching,
 * archiving and Esc all still know which session the user came from; it is
 * handed to the reducer rather than kept here a second time.
 *
 * The panels themselves are swapped by style, following this route, in
 * `ui/main-area/install-main-area`.
 */
import type { RendererEvent } from './events';

/** What a project route shows: its page (#173), one of its plans (#128), or its settings (#176). */
export type ProjectView =
  | { readonly kind: 'overview' }
  | { readonly kind: 'plan'; readonly repository: string; readonly number: number }
  | { readonly kind: 'settings' };

export type MainAreaRoute =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'sessionWork'; readonly sessionId: string }
  | { readonly kind: 'project'; readonly projectPath: string; readonly view: ProjectView }
  | { readonly kind: 'settings' }
  /** The Tasks page (#249), only while BlaakTasks is on. */
  | { readonly kind: 'tasks' }
  | { readonly kind: 'empty' };

export interface MainAreaState {
  readonly route: MainAreaRoute;
}

const EMPTY: MainAreaRoute = { kind: 'empty' };

/**
 * The empty screen at start, which is what index.html shows: a session
 * restored from storage takes the main area only once its terminal is shown.
 */
export const initialMainAreaState: MainAreaState = { route: EMPTY };

/**
 * `returnTo` is the active session as this event left it: where closing a
 * project, the settings or a session's work page goes back to.
 */
export function mainAreaReducer(state: MainAreaState, event: RendererEvent, returnTo: string | null): MainAreaState {
  switch (event.type) {
    // A session's terminal put on screen: a row click, a launch, ⌘↑/↓.
    case 'sessionShown':
      return routed(state, { kind: 'session', sessionId: event.sessionId });

    case 'sessionWorkOpened':
      return routed(state, { kind: 'sessionWork', sessionId: event.sessionId });

    case 'sessionWorkClosed':
      return state.route.kind === 'sessionWork' && state.route.sessionId === event.sessionId
        ? routed(state, back(returnTo))
        : state;

    case 'settingsOpened':
      return routed(state, { kind: 'settings' });

    case 'settingsClosed':
      return state.route.kind === 'settings' ? routed(state, back(returnTo)) : state;

    case 'projectOpened':
      return routed(state, { kind: 'project', projectPath: event.projectPath, view: event.view });

    // Esc or Close on a project.
    case 'projectClosed':
      return state.route.kind === 'project' ? routed(state, back(returnTo)) : state;

    case 'tasksOpened':
      return routed(state, { kind: 'tasks' });

    // Esc or Close on the Tasks page, or BlaakTasks switched off under it.
    case 'tasksClosed':
      return state.route.kind === 'tasks' ? routed(state, back(returnTo)) : state;

    case 'blaakTasksSwitched':
      return !event.on && state.route.kind === 'tasks' ? routed(state, back(returnTo)) : state;

    // The session went away (stopped, archived, cleared): its own pages go
    // with it, but a project or the settings covering it stay where they are,
    // only with nothing to return to.
    case 'activeSessionChanged':
      return event.sessionId === null && (state.route.kind === 'session' || state.route.kind === 'sessionWork')
        ? routed(state, EMPTY)
        : state;

    // The empty screen asked for outright: a click on the list's blank space.
    case 'screenCleared':
      return routed(state, EMPTY);

    default:
      return state;
  }
}

/** A re-keyed session stays on screen under its new id. */
export function rekeyMainArea(state: MainAreaState, oldId: string, newId: string): MainAreaState {
  if (oldId === newId) return state;
  const { route } = state;
  if ((route.kind === 'session' || route.kind === 'sessionWork') && route.sessionId === oldId) {
    return { route: { ...route, sessionId: newId } };
  }
  return state;
}

/**
 * The session whose sidebar row is lit: the one on screen, as its terminal
 * or as its work page. Nothing is lit while a project, the settings or the
 * empty screen has the main area.
 */
export function highlightedSession(state: MainAreaState): string | null {
  const { route } = state;
  return route.kind === 'session' || route.kind === 'sessionWork' ? route.sessionId : null;
}

/** The project the main area shows, and which of its views; null for any other route. */
export function projectRoute(state: MainAreaState): { readonly projectPath: string; readonly view: ProjectView } | null {
  const { route } = state;
  return route.kind === 'project' ? { projectPath: route.projectPath, view: route.view } : null;
}

/** The project route's plan, when it shows one. */
export function projectPlan(state: MainAreaState): { readonly projectPath: string; readonly repository: string; readonly number: number } | null {
  const { route } = state;
  if (route.kind !== 'project' || route.view.kind !== 'plan') return null;
  return { projectPath: route.projectPath, repository: route.view.repository, number: route.view.number };
}

/** The owner a project's plan view opens under (see `plan-slice`), apart from the Plan tab's. */
export function projectPlanOwner(plan: { readonly repository: string; readonly number: number }): string {
  return 'plan:' + plan.repository + '#' + plan.number;
}

/** Where leaving a page goes: the session to return to, or the empty screen. */
function back(returnTo: string | null): MainAreaRoute {
  return returnTo ? { kind: 'session', sessionId: returnTo } : EMPTY;
}

/** `state` itself when the route is the same one, so nothing is told about nothing. */
function routed(state: MainAreaState, route: MainAreaRoute): MainAreaState {
  return sameRoute(state.route, route) ? state : { route };
}

function sameRoute(a: MainAreaRoute, b: MainAreaRoute): boolean {
  switch (a.kind) {
    case 'session':
    case 'sessionWork':
      return b.kind === a.kind && b.sessionId === a.sessionId;
    case 'project':
      return b.kind === 'project' && b.projectPath === a.projectPath && sameView(a.view, b.view);
    default:
      return b.kind === a.kind;
  }
}

function sameView(a: ProjectView, b: ProjectView): boolean {
  if (a.kind === 'plan') return b.kind === 'plan' && b.repository === a.repository && b.number === a.number;
  return b.kind === a.kind;
}
