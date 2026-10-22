/**
 * The project page's own state (#173): which of its plans are expanded,
 * whether closed ones show, where the keyboard cursor is and what the rows are
 * filtered by.
 *
 * It belongs to one project at a time, the one whose page last opened. The
 * expanded plans and Show closed are that project's memory, persisted per
 * project in localStorage (`ui/project-page/install-project-page` reads it
 * back as the page opens and writes it as it changes); the cursor and the
 * filter start empty every time the page opens.
 *
 * The project's overview (#172) is kept here too, as main last answered it
 * for the open project: `ui/project-page/install-project-page` asks for it as
 * the page opens and every minute while it stays on screen (#174). Which of
 * its rows are on screen is `ui/project-page/page-rows`.
 *
 * What else the page shows is not here: the route says which project and
 * which of its views (`main-area-slice`), and the sessions come from the
 * cached projects.
 *
 * The events are declared here rather than in `events.ts`, like the session
 * list's, so the page's vocabulary stays in one file.
 */
import type { RendererEvent } from './events';
import type { RendererState } from './root';
import { projectRoute } from './main-area-slice';
import type { ProjectOverview } from '../../domain/project/overview';
import type { IssueSessionStart } from '../../domain/plan/issue-session';

export type ProjectPageEvent =
  /** The page opened on `projectPath`, with what it remembered of it. */
  | { type: 'projectPageRestored'; projectPath: string; memory: ProjectPageMemory }
  /** A plan (`owner/repo#n`) expanded or collapsed in place. */
  | { type: 'projectPlanToggled'; plan: string }
  /** A plan expanded (→), or collapsed (←); nothing when it already is. */
  | { type: 'projectPlanExpanded'; plan: string }
  | { type: 'projectPlanCollapsed'; plan: string }
  /** Main answered the overview of `projectPath`, asked with closed plans and merged PRs or without. */
  | { type: 'projectOverviewAnswered'; projectPath: string; closed: boolean; merged: boolean; overview: ProjectOverview }
  /** Show N more: every issue that is not in a plan, not only the first few. */
  | { type: 'projectLooseExpanded' }
  /** Start session on an issue (`owner/repo#n`) under the page, and how it went. */
  | { type: 'projectIssueStartAsked'; issue: string }
  | { type: 'projectIssueStartAnswered'; issue: string; result: IssueSessionStart }
  | { type: 'projectShowClosedToggled' }
  /** Show merged in the Pull requests section (#175). */
  | { type: 'projectShowMergedToggled' }
  /** Start session on one of the project's worktrees (#175), by its path, and how it went. */
  | { type: 'projectWorktreeStartAsked'; path: string }
  | { type: 'projectWorktreeStartAnswered'; path: string; result: { ok: true; sessionId: string } | { ok: false; reason: string } }
  /** The keyboard cursor moved to a row (null: it is gone). */
  | { type: 'projectCursorMoved'; target: string | null }
  /** The text the page's rows are filtered by (`/`). */
  | { type: 'projectFilterChanged'; filter: string };

/** What a project's page remembers between visits. */
export interface ProjectPageMemory {
  /** Plans expanded in place, as `owner/repo#n`. */
  readonly expandedPlans: readonly string[];
  readonly showClosed: boolean;
}

export interface ProjectPageState extends ProjectPageMemory {
  /** The project the rest belongs to; null until a page has opened. */
  readonly projectPath: string | null;
  /** The row the keyboard cursor is on, by the id its section gives it. */
  readonly cursor: string | null;
  readonly filter: string;
  /** Main's last answer for the project; null until the first one comes. */
  readonly overview: ProjectOverview | null;
  /** Show N more was clicked: the issues not in a plan are listed in full. */
  readonly looseExpanded: boolean;
  /** A session starting on one of the page's issues, or why the last one did not. */
  readonly start: ProjectIssueStart | null;
  /** Show merged: merged pull requests are listed after the open ones (#175). Not remembered. */
  readonly showMerged: boolean;
  /** A session starting in one of the project's worktrees, or why the last one did not (#175). */
  readonly worktreeStart: ProjectWorktreeStart | null;
}

export type ProjectIssueStart =
  | { readonly issue: string; readonly phase: 'starting' }
  | { readonly issue: string; readonly phase: 'failed'; readonly reason: string };

export type ProjectWorktreeStart =
  | { readonly path: string; readonly phase: 'starting' }
  | { readonly path: string; readonly phase: 'failed'; readonly reason: string };

export const NO_MEMORY: ProjectPageMemory = { expandedPlans: [], showClosed: false };

export const initialProjectPageState: ProjectPageState = {
  projectPath: null, ...NO_MEMORY, cursor: null, filter: '', overview: null, looseExpanded: false, start: null,
  showMerged: false, worktreeStart: null,
};

export function projectPageReducer(state: ProjectPageState, event: RendererEvent): ProjectPageState {
  switch (event.type) {
    case 'projectPageRestored':
      return {
        projectPath: event.projectPath,
        expandedPlans: event.memory.expandedPlans,
        showClosed: event.memory.showClosed,
        cursor: null,
        filter: '',
        // The same project again keeps its last answer on screen until the next.
        overview: state.projectPath === event.projectPath ? state.overview : null,
        looseExpanded: false,
        start: null,
        showMerged: false,
        worktreeStart: null,
      };

    case 'projectPlanToggled': {
      if (state.projectPath === null) return state;
      const open = state.expandedPlans.includes(event.plan);
      return {
        ...state,
        expandedPlans: open ? state.expandedPlans.filter(p => p !== event.plan) : [...state.expandedPlans, event.plan],
      };
    }

    case 'projectPlanExpanded':
      if (state.projectPath === null || state.expandedPlans.includes(event.plan)) return state;
      return { ...state, expandedPlans: [...state.expandedPlans, event.plan] };

    case 'projectPlanCollapsed':
      if (!state.expandedPlans.includes(event.plan)) return state;
      return { ...state, expandedPlans: state.expandedPlans.filter(p => p !== event.plan) };

    case 'projectOverviewAnswered':
      // An answer for another project, or one asked before Show closed or Show merged flipped, is old news.
      if (event.projectPath !== state.projectPath || event.closed !== state.showClosed || event.merged !== state.showMerged) return state;
      return { ...state, overview: event.overview };

    case 'projectLooseExpanded':
      return state.looseExpanded ? state : { ...state, looseExpanded: true };

    case 'projectIssueStartAsked':
      return state.projectPath === null ? state : { ...state, start: { issue: event.issue, phase: 'starting' } };

    case 'projectIssueStartAnswered':
      if (state.start?.issue !== event.issue) return state;
      return {
        ...state,
        start: event.result.ok ? null : { issue: event.issue, phase: 'failed', reason: event.result.reason },
      };

    case 'projectShowClosedToggled':
      return state.projectPath === null ? state : { ...state, showClosed: !state.showClosed };

    case 'projectShowMergedToggled':
      return state.projectPath === null ? state : { ...state, showMerged: !state.showMerged };

    case 'projectWorktreeStartAsked':
      return state.projectPath === null ? state : { ...state, worktreeStart: { path: event.path, phase: 'starting' } };

    case 'projectWorktreeStartAnswered':
      if (state.worktreeStart?.path !== event.path) return state;
      return {
        ...state,
        worktreeStart: event.result.ok ? null : { path: event.path, phase: 'failed', reason: event.result.reason },
      };

    case 'projectCursorMoved':
      return state.cursor === event.target ? state : { ...state, cursor: event.target };

    case 'projectFilterChanged':
      return state.filter === event.filter ? state : { ...state, filter: event.filter };

    default:
      return state;
  }
}

/**
 * What the overview is asked for now (#174): the project, and whether closed
 * plans and (#175) merged pull requests are included, while the page shows its overview. Null while nothing
 * should be asked: the page closed, one of its plans on screen, or the moment
 * between the route opening a project and its memory (Show closed among it)
 * being read back.
 */
export function overviewRequest(state: RendererState): { projectPath: string; closed: boolean; merged: boolean } | null {
  const route = projectRoute(state.mainArea);
  if (!route || route.view.kind !== 'overview' || state.projectPage.projectPath !== route.projectPath) return null;
  return { projectPath: route.projectPath, closed: state.projectPage.showClosed, merged: state.projectPage.showMerged };
}

/** What the page remembers of its project, to persist. */
export function projectPageMemory(state: ProjectPageState): ProjectPageMemory {
  return { expandedPlans: state.expandedPlans, showClosed: state.showClosed };
}

/**
 * The row after (`step` 1) or before (-1) the cursor, in `rows`: every row
 * the page shows, in order, across its sections. From no cursor, or one on a
 * row that has gone, down starts at the first row and up at the last; the
 * ends hold.
 */
export function steppedCursor(rows: readonly string[], cursor: string | null, step: 1 | -1): string | null {
  if (!rows.length) return null;
  const at = cursor === null ? -1 : rows.indexOf(cursor);
  if (at === -1) return step === 1 ? rows[0] : rows[rows.length - 1];
  return rows[Math.min(rows.length - 1, Math.max(0, at + step))];
}

// ── Persistence ──
//
// Every project's memory is one JSON record under one localStorage key,
// keyed by project path. A project left as it opens (nothing expanded, closed
// hidden) is dropped from it rather than stored.

export type ProjectPageMemories = Readonly<Record<string, ProjectPageMemory>>;

/** The stored record, or an empty one when there is none or it is not ours. */
export function parseProjectPageMemories(stored: string | null): ProjectPageMemories {
  if (!stored) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const memories: Record<string, ProjectPageMemory> = {};
  for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { expandedPlans, showClosed } = value as Record<string, unknown>;
    memories[path] = {
      expandedPlans: Array.isArray(expandedPlans) ? expandedPlans.filter((p): p is string => typeof p === 'string') : [],
      showClosed: showClosed === true,
    };
  }
  return memories;
}

/** `projectPath`'s memory, or the page as it first opens. */
export function memoryOf(memories: ProjectPageMemories, projectPath: string): ProjectPageMemory {
  return memories[projectPath] ?? NO_MEMORY;
}

/** `memories` with `projectPath`'s replaced by `memory`. */
export function remembered(memories: ProjectPageMemories, projectPath: string, memory: ProjectPageMemory): ProjectPageMemories {
  const { [projectPath]: _old, ...others } = memories;
  if (!memory.expandedPlans.length && !memory.showClosed) return others;
  return { ...others, [projectPath]: { expandedPlans: memory.expandedPlans, showClosed: memory.showClosed } };
}
