/**
 * The filter toggles above the session list.
 *
 * Three of the four are mutually exclusive with each other rather than
 * cumulative: "archived", "starred" and "running" each answer a different
 * question about the whole list, and combining them mostly produces an empty
 * one. "Today" narrows whichever of those is active, so it stacks.
 */
import { refreshSidebar, reloadProjects } from '../../app/refresh';
import { view } from '../../state/session-store';
import { el } from '../../lib/dom';
import { ICONS } from '../../lib/icons';
import { showAddProjectDialog } from '../dialogs/add-project-dialog';
import { showProjectPickerDialog } from '../dialogs/project-picker-dialog';
import { openSettingsViewer } from '../settings/settings-panel';

/** The three toggles that replace one another. */
type ExclusiveFilter = 'showArchived' | 'showStarredOnly' | 'showRunningOnly';

export function installSidebarFilters(): void {
  const archiveToggle = el('archive-toggle');
  const starToggle = el('star-toggle');
  const runningToggle = el('running-toggle');
  const todayToggle = el('today-toggle');

  const exclusive: Record<ExclusiveFilter, HTMLElement> = {
    showArchived: archiveToggle,
    showStarredOnly: starToggle,
    showRunningOnly: runningToggle,
  };

  const toggleExclusive = (filter: ExclusiveFilter): void => {
    const next = !view[filter];
    for (const key of Object.keys(exclusive) as ExclusiveFilter[]) {
      view[key] = key === filter ? next : false;
      exclusive[key].classList.toggle('active', view[key]);
    }
    refreshSidebar({ resort: true });
  };

  archiveToggle.innerHTML = ICONS.archive(18);
  archiveToggle.addEventListener('click', () => toggleExclusive('showArchived'));
  starToggle.addEventListener('click', () => toggleExclusive('showStarredOnly'));
  runningToggle.addEventListener('click', () => toggleExclusive('showRunningOnly'));

  todayToggle.addEventListener('click', () => {
    view.showTodayOnly = !view.showTodayOnly;
    todayToggle.classList.toggle('active', view.showTodayOnly);
    refreshSidebar({ resort: true });
  });

  // Re-sort: the one place the open session gives up its parked slot.
  el('resort-btn').addEventListener('click', () => void reloadProjects({ resort: true }));

  const settingsButton = el('global-settings-btn');
  settingsButton.innerHTML = ICONS.gear(18);
  settingsButton.addEventListener('click', () => void openSettingsViewer('global'));

  el('add-project-btn').addEventListener('click', () => showAddProjectDialog());
  el('new-session-btn').addEventListener('click', () => showProjectPickerDialog());
}
