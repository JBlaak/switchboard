/**
 * Keeping the rows on screen in step with their sessions' activity.
 *
 * A busy, ready or waiting change usually does not warrant a re-render, so the
 * row's classes and its agents badge are updated in place — here, off the
 * store, rather than by the store writing to the DOM. Where a change does move
 * a row between sections, the IPC follow-up re-renders as well, and the render
 * builds the row from the same state.
 */
import { store } from '../../state/app-store';
import { rowActivityChanges } from '../../state/row-activity';
import { writeAgentsBadge } from './sidebar-row';

export function installSidebarActivity(): void {
  store.subscribe((state, previous, event) => {
    // A re-key moves every mark from the old id to the new one, but the row
    // on screen still says the old id until the IPC follow-up re-renders it:
    // toggling here would strip the old id's classes off the very row that is
    // about to carry them under the new one.
    if (event.type === 'sessionForked') return;
    for (const change of rowActivityChanges(previous, state)) {
      const row = document.querySelector<HTMLElement>(`.session-item[data-session-id="${change.sessionId}"]`);
      if (!row) continue;
      for (const [name, on] of Object.entries(change.classes)) row.classList.toggle(name, on);
      if (change.agentsChanged) writeAgentsBadge(row, change.next.agents);
    }
  });
}
