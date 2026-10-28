/**
 * The top row of the sidebar header: the Phone access indicator, sleep,
 * appearance, the Tasks page (only while BlaakTasks is on, #249), global
 * settings and collapse, right-aligned and level with the
 * traffic lights. The header around it is a window drag region; the buttons
 * opt out in `_chrome.scss`.
 */
import { ICONS } from '../../lib/icons';
import { openSettings } from '../settings/actions';
import { AppearanceToggle } from './AppearanceToggle';
import { SleepToggle } from './SleepToggle';
import { PhoneIndicator } from '../phone-access/PhoneIndicator';
import { SidebarCollapseIcon } from './icons';
import { setSidebarCollapsed } from './actions';
import { useStore } from '../use-store';
import { toggleTasksPage } from '../tasks-page/actions';
import type { JSX } from 'react';

const GEAR = { __html: ICONS.gear(18) };

/** The Tasks page's entry point: a checklist, lit while the page is on screen. */
function TasksButton(): JSX.Element | null {
  const enabled = useStore(s => s.tasks.enabled);
  const open = useStore(s => s.mainArea.route.kind === 'tasks');
  if (!enabled) return null;
  return (
    <button
      id="tasks-page-btn"
      className={open ? 'active' : undefined}
      title="Tasks (⌘T)"
      aria-label="Tasks"
      aria-pressed={open}
      onClick={toggleTasksPage}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m4 7 2 2 3.5-4M4 16l2 2 3.5-4M13 8h7M13 17h7" />
      </svg>
    </button>
  );
}

export function SidebarToolbar(): JSX.Element {
  return (
    <div id="sidebar-toolbar">
      <PhoneIndicator />
      <SleepToggle />
      <AppearanceToggle />
      <TasksButton />
      <button
        id="global-settings-btn"
        title="Global settings"
        dangerouslySetInnerHTML={GEAR}
        onClick={() => void openSettings()}
      />
      <button id="sidebar-collapse-btn" title="Hide sidebar" onClick={() => setSidebarCollapsed(true)}>
        <SidebarCollapseIcon />
      </button>
    </div>
  );
}
