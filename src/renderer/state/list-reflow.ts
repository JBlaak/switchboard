/**
 * When a redraw of the session list may glide its rows (`ui/session-list/use-reflow`).
 *
 * Pure, so the rule can be tested in node; the FLIP itself needs the DOM.
 */
import type { RendererState } from './root';

/**
 * Whether the redraw from `previous` to `state` glides.
 *
 * The first render has nothing to glide from: everything would fade in at
 * once. A collapsed sidebar shows no list to watch, so measuring it is wasted
 * work.
 */
export function redrawGlides(previous: RendererState, state: RendererState): boolean {
  return previous.sessionList.layout !== null && !state.toolbar.sidebarCollapsed;
}
