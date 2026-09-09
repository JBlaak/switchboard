/**
 * The long-lived elements of index.html, looked up once.
 *
 * These used to be top-level `const`s in app.ts that every other file reached
 * through the shared global scope. Pulling them into a leaf module is what lets
 * the rest of the renderer import what it uses instead of hoping app.js had
 * already run — and it breaks the import cycles that arrangement created.
 */

/**
 * Look up an element that index.html is required to contain.
 *
 * Every id below is static markup, so a miss is a bug in the HTML rather than a
 * runtime condition worth threading `| null` through the entire renderer.
 */
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`index.html is missing #${id}`);
  return found as T;
}

// Sidebar
export const projectRail = el('project-rail');
export const sidebarContent = el('sidebar-content');
export const filesContent = el('files-content');
export const plansContent = el('plans-content');
export const statsContent = el('stats-content');
export const memoryContent = el('memory-content');
export const searchBar = el('search-bar');
export const searchInput = el<HTMLInputElement>('search-input');
export const loadingStatus = el('loading-status');
export const sessionFilters = el('session-filters');

// Main area
export const placeholder = el('placeholder');
export const terminalArea = el('terminal-area');
export const terminalsEl = el('terminals');
export const terminalHeader = el('terminal-header');

// Viewers
export const planViewer = el('plan-viewer');
export const memoryViewer = el('memory-viewer');
export const statsViewer = el('stats-viewer');
export const statsViewerBody = el('stats-viewer-body');
export const jsonlViewer = el('jsonl-viewer');
export const jsonlViewerTitle = el('jsonl-viewer-title');
export const jsonlViewerSessionId = el('jsonl-viewer-session-id');
export const jsonlViewerBody = el('jsonl-viewer-body');
export const settingsViewer = el('settings-viewer');
// The session-less code panel. Empty in index.html — the code area builds its
// own header and lets the shared viewer panel fill the rest — but static, so
// this handle can be resolved at import like every other one here.
export const codeArea = el('code-area');

// Grid view
export const gridViewer = el('grid-viewer');
export const gridViewerCount = el('grid-viewer-count');
