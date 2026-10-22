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
 * What the page shows is not here: the route says which project and which of
 * its views (`main-area-slice`), and the sessions come from the cached
 * projects. GitHub's side of the page (#172's overview) is for the sections
 * that read it to add.
 *
 * The events are declared here rather than in `events.ts`, like the session
 * list's, so the page's vocabulary stays in one file.
 */
import type { RendererEvent } from './events';

export type ProjectPageEvent =
  /** The page opened on `projectPath`, with what it remembered of it. */
  | { type: 'projectPageRestored'; projectPath: string; memory: ProjectPageMemory }
  /** A plan (`owner/repo#n`) expanded or collapsed in place. */
  | { type: 'projectPlanToggled'; plan: string }
  | { type: 'projectShowClosedToggled' }
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
}

export const NO_MEMORY: ProjectPageMemory = { expandedPlans: [], showClosed: false };

export const initialProjectPageState: ProjectPageState = {
  projectPath: null, ...NO_MEMORY, cursor: null, filter: '',
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
      };

    case 'projectPlanToggled': {
      if (state.projectPath === null) return state;
      const open = state.expandedPlans.includes(event.plan);
      return {
        ...state,
        expandedPlans: open ? state.expandedPlans.filter(p => p !== event.plan) : [...state.expandedPlans, event.plan],
      };
    }

    case 'projectShowClosedToggled':
      return state.projectPath === null ? state : { ...state, showClosed: !state.showClosed };

    case 'projectCursorMoved':
      return state.cursor === event.target ? state : { ...state, cursor: event.target };

    case 'projectFilterChanged':
      return state.filter === event.filter ? state : { ...state, filter: event.filter };

    default:
      return state;
  }
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
