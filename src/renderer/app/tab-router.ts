/**
 * The five tabs, and what the main area shows for each.
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
  filesContent, gridViewer, memoryContent, placeholder, plansContent,
  searchBar, searchInput, sidebarContent, statsContent,
  terminalHeader, el,
} from '../lib/dom';
import { fitAndScroll, showSession } from '../features/terminal/terminal-manager';
import { hideAllViewers, showViewer } from '../features/panel/viewers';
import { loadPlans } from '../features/plans/plans-view';
import { loadMemories } from '../features/memory/memory-view';
import { loadStats } from '../features/stats/stats-view';
import { showFileTree } from '../features/files/file-tree';

type TabName = 'sessions' | 'files' | 'plans' | 'stats' | 'memory';

/** The search box's placeholder per tab; absent means the box is hidden. */
const SEARCH_PLACEHOLDERS: Partial<Record<TabName, string>> = {
  sessions: 'Search sessions...',
  files: 'Find file in this worktree…',
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
    case 'files':
      filesContent.style.display = '';
      // A file is opened into the main area, so the tab starts by putting back
      // whatever was there — coming from stats, that viewer is still up.
      restoreMainArea();
      showFileTree();
      break;
    case 'plans':
      // The main area has to be put back, not left as it was: these two tabs
      // replace the sidebar's list and nothing else, so arriving from a tab that
      // shows a panel — statistics, or now the code area — used to leave that
      // panel up beside them until something else happened to hide it.
      restoreMainArea();
      plansContent.style.display = '';
      void loadPlans();
      break;
    case 'stats':
      statsContent.style.display = '';
      showViewer('stats');
      void loadStats();
      break;
    case 'memory':
      restoreMainArea();
      memoryContent.style.display = '';
      void loadMemories();
      break;
  }
}

function hideSidebarPanels(): void {
  sidebarContent.style.display = 'none';
  filesContent.style.display = 'none';
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
 * Three things, only one of which is about the main area: the filter row and
 * the session list come back, `restoreMainArea` puts back what was beside them,
 * and any projects change that arrived while another tab was up is caught up
 * on. A tab that only wants the main area restored calls that half directly.
 */
function showSessions(): void {
  el('session-filters').style.display = '';
  sidebarContent.style.display = '';
  restoreMainArea();

  // Catch up on changes that arrived while another tab was up.
  if (consumeDeferredProjectsChange()) void reloadProjects();
}

/**
 * Put the main area back to whatever it was showing.
 *
 * The grid, the open session, or the placeholder — and any panel that had taken
 * the space comes down. Terminals are refitted because they were hidden while a
 * panel was up, and xterm cannot measure a hidden element.
 *
 * Every tab that fills the sidebar without claiming the main area needs this.
 * Leaving it out is not "no change": the tab arrived from is as likely as not
 * to have been one that *did* claim the space, and its panel would simply stay.
 */
function restoreMainArea(): void {
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

/**
 * `restoreMainArea` under the name the main area's own chrome uses.
 *
 * The code area's back button has to undo a `showViewer` the same way a tab
 * switch does. Reaching for `hideAllViewers` alone would put the terminal back
 * unmeasured, so there is one path out of a panel, not two.
 */
export function showTerminalArea(): void {
  restoreMainArea();
}
