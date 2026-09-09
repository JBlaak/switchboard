/**
 * The four tabs, and what the main area shows for each.
 *
 * Every tab owns both halves of the window: the sidebar's content and what
 * fills the space beside it. Switching hides everything and then shows the one
 * tab's pair, which is verbose but leaves no combination of leftovers on screen.
 */
import { clearSessionMatches } from './search';
import { consumeDeferredProjectsChange } from './ipc-listeners';
import { reloadProjects } from './refresh';
import { openSessions, view } from '../state/session-store';
import {
  gridViewer, memoryContent, placeholder, plansContent,
  searchBar, searchInput, sidebarContent, statsContent,
  terminalHeader, el,
} from '../lib/dom';
import { fitAndScroll, showSession } from '../features/terminal/terminal-manager';
import { hideAllViewers, showViewer } from '../features/panel/viewers';
import { loadPlans } from '../features/plans/plans-view';
import { loadMemories } from '../features/memory/memory-view';
import { loadStats } from '../features/stats/stats-view';

type TabName = 'sessions' | 'plans' | 'stats' | 'memory';

/** The search box's placeholder per tab; absent means the box is hidden. */
const SEARCH_PLACEHOLDERS: Partial<Record<TabName, string>> = {
  sessions: 'Search sessions...',
  plans: 'Search plans...',
  memory: 'Search agent files...',
};

export function installTabRouter(): void {
  document.querySelectorAll<HTMLElement>('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab as TabName | undefined;
      if (!name || name === view.activeTab) return;
      switchTo(name);
    });
  });
}

function switchTo(name: TabName): void {
  view.activeTab = name;
  document.querySelectorAll<HTMLElement>('.sidebar-tab')
    .forEach(t => t.classList.toggle('active', t.dataset.tab === name));

  // A query is scoped to the tab it was typed in.
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  clearSessionMatches();

  hideSidebarPanels();
  applySearchBox(name);

  switch (name) {
    case 'sessions':
      showSessions();
      break;
    case 'plans':
      plansContent.style.display = '';
      void loadPlans();
      break;
    case 'stats':
      statsContent.style.display = '';
      showViewer('stats');
      void loadStats();
      break;
    case 'memory':
      memoryContent.style.display = '';
      void loadMemories();
      break;
  }
}

function hideSidebarPanels(): void {
  sidebarContent.style.display = 'none';
  plansContent.style.display = 'none';
  statsContent.style.display = 'none';
  memoryContent.style.display = 'none';
  el('session-filters').style.display = 'none';
  searchBar.style.display = 'none';
}

function applySearchBox(name: TabName): void {
  const placeholder = SEARCH_PLACEHOLDERS[name];
  if (!placeholder) return;
  searchBar.style.display = '';
  searchInput.placeholder = placeholder;
}

/**
 * Back to the sessions tab.
 *
 * The sidebar half only; the main area is put back by `showTerminalArea`.
 */
function showSessions(): void {
  el('session-filters').style.display = '';
  sidebarContent.style.display = '';
  showTerminalArea();

  // Catch up on changes that arrived while another tab was up.
  if (consumeDeferredProjectsChange()) void reloadProjects();
}

/**
 * Put the terminal back in the main area.
 *
 * Whatever was on screen before comes back: the grid, the open session, or the
 * placeholder. Terminals are refitted because they were hidden while a panel
 * was up, and xterm cannot measure a hidden element.
 *
 * Exported because the code area's back button has to undo a `showViewer` the
 * same way a tab switch does. Reaching for `hideAllViewers` alone would put the
 * terminal back unmeasured, so there is one path out of a panel, not two.
 */
export function showTerminalArea(): void {
  hideAllViewers();

  if (view.gridViewActive) {
    placeholder.style.display = 'none';
    terminalHeader.style.display = 'none';
    gridViewer.style.display = 'block';
    for (const entry of openSessions.values()) {
      if (!entry.closed) fitAndScroll(entry);
    }
  } else if (view.activeSessionId && openSessions.has(view.activeSessionId)) {
    showSession(view.activeSessionId);
  } else {
    placeholder.style.display = '';
  }
}
