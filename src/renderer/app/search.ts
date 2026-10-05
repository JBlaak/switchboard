/**
 * The search box.
 *
 * The query narrows the session list. Debounced, because the index is queried
 * per keystroke and a trigram search over a large history is not free.
 *
 * Title-only search additionally matches project names, which full-text search
 * cannot do — a project's name is not in any session's body.
 */
import { shortProjectPath } from '../../domain/project/project-path';
import { refreshSidebar } from './refresh';
import { view } from '../state/session-store';
import { searchBar, searchInput, el } from '../lib/dom';

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

/** Empty the box and put the session list back to unfiltered. */
export function clearSearch(): void {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }

  clearSessionMatches();
  refreshSidebar({ resort: true });
}

/** Drop the search state without redrawing. */
function clearSessionMatches(): void {
  view.searchMatchIds = null;
  view.searchMatchProjectPaths = null;
}

async function runSearch(): Promise<void> {
  debounce = null;
  const query = searchInput.value.trim();
  if (!query) {
    clearSearch();
    return;
  }

  try {
    await searchSessions(query);
  } catch {
    // A query FTS5 cannot parse is not an error worth showing mid-typing; drop
    // back to the unfiltered list.
    clearSessionMatches();
    refreshSidebar({ resort: true });
  }
}

async function searchSessions(query: string): Promise<void> {
  const results = await window.api.search('session', query, titleOnly);
  view.searchMatchIds = new Set(results.map(r => r.id));
  view.searchMatchProjectPaths = titleOnly ? matchingProjectPaths(query) : null;
  refreshSidebar({ resort: true });
}

/** Projects whose own short name contains the query. */
function matchingProjectPaths(query: string): Set<string> | null {
  const needle = query.toLowerCase();
  const matched = new Set<string>();
  for (const project of view.cachedAllProjects) {
    if (shortProjectPath(project.projectPath).toLowerCase().includes(needle)) {
      matched.add(project.projectPath);
    }
  }
  return matched.size ? matched : null;
}
