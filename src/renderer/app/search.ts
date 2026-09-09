/**
 * The search box.
 *
 * One box, four tabs: the query goes to whichever category the user is looking
 * at, and the results narrow that tab's list. Debounced, because the index is
 * queried per keystroke and a trigram search over a large history is not free.
 *
 * The Files tab is the exception to all of that: its tree is already in the
 * renderer, so its query is a local filter over what is loaded rather than a
 * question for the index. It still goes through the same debounce — a filter of
 * a deep tree per keystroke is cheap but not free.
 *
 * Title-only search additionally matches project names, which full-text search
 * cannot do — a project's name is not in any session's body.
 */
import { shortProjectPath } from '../../domain/project/project-path';
import { refreshSidebar } from './refresh';
import { scopedProjects } from '../state/scope-store';
import { view } from '../state/session-store';
import { searchBar, searchInput, el } from '../lib/dom';
import { renderPlans } from '../features/plans/plans-view';
import { renderMemories } from '../features/memory/memory-view';
import { forgetFileTreeQuery, setFileTreeQuery } from '../features/files/file-tree';

const DEBOUNCE_MS = 200;

let debounce: ReturnType<typeof setTimeout> | null = null;
let titleOnly = false;

export function installSearch(): void {
  const clearButton = el('search-clear');
  const titlesToggle = el('search-titles-toggle');

  void (async () => {
    if (await window.api.getSetting('searchTitlesOnly')) {
      titleOnly = true;
      titlesToggle.classList.add('active');
    }
  })();

  titlesToggle.addEventListener('click', () => {
    titleOnly = !titleOnly;
    titlesToggle.classList.toggle('active', titleOnly);
    void window.api.setSetting('searchTitlesOnly', titleOnly);
    // Re-run whatever is in the box under the new rule.
    if (searchInput.value.trim()) searchInput.dispatchEvent(new Event('input'));
  });

  clearButton.addEventListener('click', () => {
    clearSearch();
    searchInput.focus();
  });

  searchInput.addEventListener('input', () => {
    searchBar.classList.toggle('has-query', searchInput.value.length > 0);
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void runSearch(), DEBOUNCE_MS);
  });
}

/** Empty the box and put every tab back to its unfiltered list. */
export function clearSearch(): void {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }

  switch (view.activeTab) {
    case 'sessions':
      clearSessionMatches();
      refreshSidebar({ resort: true });
      break;
    case 'files':
      setFileTreeQuery('');
      break;
    case 'plans':
      renderPlans(view.cachedPlans);
      break;
    case 'memory':
      renderMemories();
      break;
  }
}

/**
 * Drop the search state without redrawing — for a tab switch.
 *
 * The file tree's query is dropped unconditionally rather than under a
 * `switch`: it is one assignment, it is the same answer for every tab, and the
 * tree redraws from scratch when its tab next comes up either way.
 */
export function clearSessionMatches(): void {
  view.searchMatchIds = null;
  view.searchMatchProjectPaths = null;
  forgetFileTreeQuery();
}

async function runSearch(): Promise<void> {
  debounce = null;
  const query = searchInput.value.trim();
  if (!query) {
    clearSearch();
    return;
  }

  try {
    switch (view.activeTab) {
      case 'sessions':
        await searchSessions(query);
        break;
      case 'files':
        // No IPC: the tree filters what it has already loaded.
        setFileTreeQuery(query);
        break;
      case 'plans': {
        const results = await window.api.search('plan', query, titleOnly);
        const ids = new Set(results.map(r => r.id));
        renderPlans(view.cachedPlans.filter(p => ids.has(p.filename)));
        break;
      }
      case 'memory': {
        const results = await window.api.search('memory', query, titleOnly);
        renderMemories(new Set(results.map(r => r.id)));
        break;
      }
    }
  } catch {
    // A query FTS5 cannot parse is not an error worth showing mid-typing; drop
    // back to the unfiltered list.
    if (view.activeTab === 'sessions') {
      clearSessionMatches();
      refreshSidebar({ resort: true });
    }
  }
}

async function searchSessions(query: string): Promise<void> {
  const results = await window.api.search('session', query, titleOnly);
  view.searchMatchIds = new Set(results.map(r => r.id));
  view.searchMatchProjectPaths = titleOnly ? matchingProjectPaths(query) : null;
  refreshSidebar({ resort: true });
}

/**
 * Projects whose own short name contains the query.
 *
 * Read off the scoped list: a name match admits every session of the project,
 * so matching against the full list would let a search inside a scope pull
 * another project's sessions in by name alone.
 */
function matchingProjectPaths(query: string): Set<string> | null {
  const needle = query.toLowerCase();
  const matched = new Set<string>();
  for (const project of scopedProjects(view.cachedAllProjects)) {
    if (shortProjectPath(project.projectPath).toLowerCase().includes(needle)) {
      matched.add(project.projectPath);
    }
  }
  return matched.size ? matched : null;
}
