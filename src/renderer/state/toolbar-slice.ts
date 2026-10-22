/**
 * The sidebar chrome's own state: whether the sidebar is collapsed, the first
 * load's status, the search box, and the three toolbar switches.
 *
 * What the controls *do* to the session list — the filters and the search
 * matches — lives in the view slice, beside the rest of what the list reads.
 * This holds only what the controls show, so the list never has to know about
 * a tooltip or a pending password prompt.
 *
 * The events are declared here rather than in `events.ts` so the toolbar's
 * vocabulary stays in one file; `events.ts` folds them into the union.
 */
import { normaliseAppearance } from '../../domain/settings/appearance';
import type { Appearance } from '../../domain/settings/appearance';
import type { RendererEvent } from './events';

/** The four filter toggles above the list. */
export type SidebarFilter = 'running' | 'pinned' | 'archived' | 'today';

export type ToolbarEvent =
  | { type: 'sidebarCollapsed'; collapsed: boolean }
  /** The project list is being fetched for the first time (or has been). */
  | { type: 'projectsLoading'; loading: boolean }
  /** A fetched project list had projects in it, or had none (archived ones count). */
  | { type: 'projectsCounted'; any: boolean }
  /** A filter toggle was clicked; the view slice applies the rule. */
  | { type: 'filterToggled'; filter: SidebarFilter }
  /** What is in the search box, as typed. The query itself runs later. */
  | { type: 'searchTyped'; query: string }
  /**
   * A search came back, or was dropped: null ids is no search at all. The
   * project paths are the projects matched by name, in titles-only mode.
   */
  | { type: 'searchMatched'; ids: ReadonlySet<string> | null; projectPaths: ReadonlySet<string> | null }
  | { type: 'searchTitlesOnlyChanged'; titlesOnly: boolean }
  | { type: 'appearanceChanged'; mode: Appearance }
  /** What `pmset` says; null on a host that cannot answer. */
  | { type: 'sleepStateRead'; disabled: boolean | null }
  /** A click on the sleep switch is waiting for its answer (and maybe a password). */
  | { type: 'sleepSwitchPending'; pending: boolean }
  /** The quick session folder, trimmed; empty when none is set. */
  | { type: 'quickSessionPathRead'; path: string };

export interface ToolbarState {
  /** Not persisted: every launch starts with the sidebar open. */
  readonly sidebarCollapsed: boolean;
  readonly projectsLoading: boolean;
  /**
   * Whether there is any project at all; null until the first list is in.
   * With none, the Projects button carries a dot and the list points at it.
   */
  readonly hasProjects: boolean | null;
  readonly searchQuery: string;
  readonly searchTitlesOnly: boolean;
  readonly appearance: Appearance;
  readonly sleepDisabled: boolean | null;
  readonly sleepPending: boolean;
  readonly quickSessionPath: string;
}

export const initialToolbarState: ToolbarState = {
  sidebarCollapsed: false,
  projectsLoading: false,
  hasProjects: null,
  searchQuery: '',
  searchTitlesOnly: false,
  // The default straight away, so the button is never empty while the stored
  // setting is read.
  appearance: normaliseAppearance(undefined),
  sleepDisabled: null,
  sleepPending: false,
  quickSessionPath: '',
};

export function toolbarReducer(state: ToolbarState, event: RendererEvent): ToolbarState {
  switch (event.type) {
    case 'sidebarCollapsed':
      return set(state, 'sidebarCollapsed', event.collapsed);
    case 'projectsLoading':
      return set(state, 'projectsLoading', event.loading);
    case 'projectsCounted':
      return set(state, 'hasProjects', event.any);
    case 'searchTyped':
      return set(state, 'searchQuery', event.query);
    case 'searchTitlesOnlyChanged':
      return set(state, 'searchTitlesOnly', event.titlesOnly);
    case 'appearanceChanged':
      return set(state, 'appearance', event.mode);
    case 'sleepStateRead':
      return set(state, 'sleepDisabled', event.disabled);
    case 'sleepSwitchPending':
      return set(state, 'sleepPending', event.pending);
    case 'quickSessionPathRead':
      return set(state, 'quickSessionPath', event.path);
    default:
      return state;
  }
}

/** One field, keeping the old state when the value did not change. */
function set<K extends keyof ToolbarState>(state: ToolbarState, key: K, value: ToolbarState[K]): ToolbarState {
  return Object.is(state[key], value) ? state : { ...state, [key]: value };
}
