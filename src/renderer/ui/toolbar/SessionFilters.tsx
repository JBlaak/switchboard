/**
 * The filter row: the three filter toggles on the left, the first load's status,
 * and the two ways to start something on the right — a quick session, and the
 * Projects modal, which starts a session in a project or adds one (#171).
 */
import { openDialog } from '../dialogs/actions';
import { launchQuickSession } from '../../features/sessions/quick-session';
import { useStore } from '../use-store';
import { toggleFilter } from './actions';
import { MoonIcon, PinIcon, ProjectsIcon, QuickSessionIcon, RunningIcon } from './icons';
import type { JSX, ReactNode } from 'react';
import type { RendererState } from '../../state/root';
import type { SidebarFilter } from '../../state/toolbar-slice';

interface FilterButtonProps {
  id: string;
  filter: SidebarFilter;
  title: string;
  isOn: (state: RendererState) => boolean;
  children: ReactNode;
}

function FilterButton({ id, filter, title, isOn, children }: FilterButtonProps): JSX.Element {
  const on = useStore(isOn);
  return (
    <button
      id={id}
      title={title}
      className={on ? 'active' : undefined}
      onClick={() => toggleFilter(filter)}
    >
      {children}
    </button>
  );
}

function LoadingStatus(): JSX.Element {
  const loading = useStore(s => s.toolbar.projectsLoading);
  return (
    <span
      id="loading-status"
      className={loading ? 'active' : undefined}
      style={loading ? undefined : { display: 'none' }}
    >
      {loading ? 'Loading…' : null}
    </span>
  );
}

/** A home-folder path the way the tooltip says it: `~/Scratch` rather than `/Users/me/Scratch`. */
function tildePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

export function SessionFilters(): JSX.Element {
  const quickSessionPath = useStore(s => s.toolbar.quickSessionPath);
  // Only a list known to be empty earns the first-run dot, not one still loading.
  const noProjects = useStore(s => s.toolbar.hasProjects === false);
  return (
    <div id="session-filters">
      <FilterButton id="running-toggle" filter="running" title="Show running only" isOn={s => s.view.showRunningOnly}>
        <RunningIcon />
      </FilterButton>
      <FilterButton id="star-toggle" filter="pinned" title="Show pinned only" isOn={s => s.view.showStarredOnly}>
        <PinIcon />
      </FilterButton>
      <FilterButton id="snoozed-toggle" filter="snoozed" title="Show snoozed only" isOn={s => s.view.showSnoozedOnly}>
        <MoonIcon />
      </FilterButton>
      <LoadingStatus />
      {/* Hidden until there is a folder for it to launch in. */}
      <button
        id="quick-session-btn" hidden={!quickSessionPath} aria-label="Quick session (⌘N)"
        title={`Quick session in ${tildePath(quickSessionPath)} (⌘N)`}
        onClick={() => void launchQuickSession()}
      >
        <QuickSessionIcon />
      </button>
      <button
        id="projects-btn" aria-label="Projects" title="Projects: start, open or add (⌘A)"
        className={noProjects ? 'first-run' : undefined}
        onClick={() => openDialog({ kind: 'projectPicker' })}
      >
        <ProjectsIcon />
        {noProjects && <span className="projects-btn-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
