/**
 * What the sidebar chrome does: every IPC call and timer behind the toolbar,
 * the filter row and the search box, each ending in a dispatch.
 *
 * The components only call these. The session list is laid out on request
 * (`ui/session-list/relayout`), so the ones that change what it shows also ask
 * for a new layout — with `resort: true`,
 * because a filter or a search is a user's own action, and the one moment the
 * open session gives up the slot it is parked in.
 */
import { nextAppearance, normaliseAppearance } from '../../../domain/settings/appearance';
import { relayoutSessionList } from '../session-list/relayout';
import { matchingProjectPaths } from '../../state/search-narrowing';
import { dispatch, getState } from '../../state/app-store';
import { openSessions, view } from '../../state/session-store';
import { safeFit } from '../../features/terminal/terminal-manager';
import { syncQuickSessionButton } from '../../features/sessions/quick-session';
import { watchSleepState } from './sleep-switch';
import type { GlobalSettings } from '../../../domain/settings/settings';
import type { SidebarFilter } from '../../state/toolbar-slice';

export { toggleSleep } from './sleep-switch';
export { isSidebarToggleKey } from '../../lib/shortcut-keys';

/** Read the stored preferences the chrome shows, and start the sleep watcher. Called once, at boot. */
export function installToolbar(): void {
  void (async () => {
    if (await window.api.getSetting('searchTitlesOnly')) {
      dispatch({ type: 'searchTitlesOnlyChanged', titlesOnly: true });
    }
  })();
  void window.api.getSetting<GlobalSettings>('global').then((global) => {
    dispatch({ type: 'appearanceChanged', mode: normaliseAppearance(global?.appearance) });
  });
  void syncQuickSessionButton();
  watchSleepState();
}

// ── Collapse and resize ──

export function setSidebarCollapsed(collapsed: boolean): void {
  dispatch({ type: 'sidebarCollapsed', collapsed });
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!getState().toolbar.sidebarCollapsed);
}

/** xterm measures its grid in pixels, so the visible terminal refits when its space changes. */
export function refitActiveTerminal(): void {
  const active = view.activeSessionId ? openSessions.get(view.activeSessionId) : undefined;
  if (active) safeFit(active);
}

export async function persistSidebarWidth(width: number): Promise<void> {
  const global = (await window.api.getSetting<Record<string, unknown>>('global')) || {};
  global.sidebarWidth = width;
  await window.api.setSetting('global', global);
}

// ── Filters ──

export function toggleFilter(filter: SidebarFilter): void {
  dispatch({ type: 'filterToggled', filter });
  relayoutSessionList({ resort: true });
}

// ── Search ──

/**
 * Debounced, because the index is queried per keystroke and a trigram search
 * over a large history is not free.
 */
const SEARCH_DEBOUNCE_MS = 200;

let debounce: ReturnType<typeof setTimeout> | null = null;

/** The box changed: shown at once, queried once the typing pauses. */
export function typeSearch(query: string): void {
  dispatch({ type: 'searchTyped', query });
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void runSearch(), SEARCH_DEBOUNCE_MS);
}

/** Empty the box and put the session list back to unfiltered. */
export function clearSearch(): void {
  dispatch({ type: 'searchTyped', query: '' });
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  dropSearchMatches();
}

/** Re-run whatever is in the box under the other rule, and remember the choice. */
export function toggleSearchTitlesOnly(): void {
  const titlesOnly = !getState().toolbar.searchTitlesOnly;
  dispatch({ type: 'searchTitlesOnlyChanged', titlesOnly });
  void window.api.setSetting('searchTitlesOnly', titlesOnly);
  const { searchQuery } = getState().toolbar;
  if (searchQuery.trim()) typeSearch(searchQuery);
}

function dropSearchMatches(): void {
  dispatch({ type: 'searchMatched', ids: null, projectPaths: null });
  relayoutSessionList({ resort: true });
}

async function runSearch(): Promise<void> {
  debounce = null;
  const query = getState().toolbar.searchQuery.trim();
  if (!query) {
    clearSearch();
    return;
  }

  const { searchTitlesOnly } = getState().toolbar;
  try {
    const results = await window.api.search('session', query, searchTitlesOnly);
    dispatch({
      type: 'searchMatched',
      ids: new Set(results.map(r => r.id)),
      // A project's name is not in any session's body, so full-text search
      // cannot match it; titles-only mode matches it here instead.
      projectPaths: searchTitlesOnly ? matchingProjectPaths(query, view.cachedAllProjects) : null,
    });
    relayoutSessionList({ resort: true });
  } catch {
    // A query FTS5 cannot parse is not an error worth showing mid-typing; drop
    // back to the unfiltered list.
    dropSearchMatches();
  }
}

// ── Appearance ──

/**
 * Shown immediately; main applying the scheme (through `nativeTheme`, which
 * `prefers-color-scheme` follows) is what actually repaints, and it does not
 * need the button to wait for it.
 */
export function cycleAppearance(): void {
  const mode = nextAppearance(getState().toolbar.appearance);
  dispatch({ type: 'appearanceChanged', mode });
  void window.api.setAppearance(mode);
}
