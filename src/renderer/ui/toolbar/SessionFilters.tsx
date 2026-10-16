/**
 * The filter row: the four filter toggles, the first load's status, and the
 * three ways to start something — a quick session, a new session in a picked
 * project, and a new project.
 */
import { ICONS } from '../../lib/icons';
import { showAddProjectDialog } from '../../features/dialogs/add-project-dialog';
import { showProjectPickerDialog } from '../../features/dialogs/project-picker-dialog';
import { launchQuickSession } from '../../features/sessions/quick-session';
import { useStore } from '../use-store';
import { toggleFilter } from './actions';
import {
  AddProjectIcon, NewSessionIcon, PinIcon, QuickSessionIcon, RunningIcon, TodayIcon,
} from './icons';
import type { JSX, ReactNode } from 'react';
import type { RendererState } from '../../state/root';
import type { SidebarFilter } from '../../state/toolbar-slice';

const ARCHIVE = { __html: ICONS.archive(18) };

interface FilterButtonProps {
  id: string;
  filter: SidebarFilter;
  title: string;
  isOn: (state: RendererState) => boolean;
  /** The icon, as JSX or (for one shared with vanilla code) as HTML. */
  children?: ReactNode;
  html?: { __html: string };
}

function FilterButton({ id, filter, title, isOn, children, html }: FilterButtonProps): JSX.Element {
  const on = useStore(isOn);
  return (
    <button
      id={id}
      title={title}
      className={on ? 'active' : undefined}
      onClick={() => toggleFilter(filter)}
      dangerouslySetInnerHTML={html}
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

export function SessionFilters(): JSX.Element {
  const quickSessionPath = useStore(s => s.toolbar.quickSessionPath);
  return (
    <div id="session-filters">
      <FilterButton id="running-toggle" filter="running" title="Show running only" isOn={s => s.view.showRunningOnly}>
        <RunningIcon />
      </FilterButton>
      <FilterButton id="star-toggle" filter="pinned" title="Show pinned only" isOn={s => s.view.showStarredOnly}>
        <PinIcon />
      </FilterButton>
      <FilterButton id="today-toggle" filter="today" title="Show today's sessions only" isOn={s => s.view.showTodayOnly}>
        <TodayIcon />
      </FilterButton>
      <FilterButton
        id="archive-toggle" filter="archived" title="Show archived sessions"
        isOn={s => s.view.showArchived} html={ARCHIVE}
      />
      <LoadingStatus />
      {/* Hidden until there is a folder for it to launch in. */}
      <button
        id="quick-session-btn" hidden={!quickSessionPath} title="Quick session (⌘N)"
        onClick={() => void launchQuickSession()}
      >
        <QuickSessionIcon />
      </button>
      <button id="new-session-btn" title="New session" onClick={() => showProjectPickerDialog()}>
        <NewSessionIcon />
      </button>
      <button id="add-project-btn" title="Add project" onClick={() => showAddProjectDialog()}>
        <AddProjectIcon />
      </button>
    </div>
  );
}
