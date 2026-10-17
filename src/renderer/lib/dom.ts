/**
 * The containers of index.html that the imperative code drives, looked up once.
 *
 * Every surface is React now and portals into its container by id (see
 * `ui/Portal`); these few are also touched from outside React, each for a
 * reason that has to happen synchronously or on the element itself:
 *
 * - `sidebarContent` holds the keyboard focus while the list cursor is out,
 *   hears the list's keys, and is the scrolling container the reflow measures.
 * - `placeholder`, `terminalArea`, `settingsViewer`, `sessionWorkPanel` and
 *   `terminalHeader` are the main area's panels, swapped by style: a terminal can only take focus or
 *   be refitted once its panel has a layout box, which has to be true before
 *   the next line runs, not whenever React next commits.
 */

/**
 * Look up an element that index.html is required to contain.
 *
 * Every id below is static markup, so a miss is a bug in the HTML rather than a
 * runtime condition worth threading `| null` through the entire renderer.
 */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`index.html is missing #${id}`);
  return found as T;
}

// Sidebar
export const sidebarContent = el('sidebar-content');

// Main area
export const placeholder = el('placeholder');
export const terminalArea = el('terminal-area');
export const terminalHeader = el('terminal-header');
export const settingsViewer = el('settings-viewer');
export const sessionWorkPanel = el('session-work');
