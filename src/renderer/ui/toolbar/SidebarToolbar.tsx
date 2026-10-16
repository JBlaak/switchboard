/**
 * The top row of the sidebar header: sleep, appearance, global settings and
 * collapse, right-aligned and level with the traffic lights. The header
 * around it is a window drag region; the buttons opt out in `_chrome.scss`.
 */
import { ICONS } from '../../lib/icons';
import { openSettings } from '../settings/actions';
import { AppearanceToggle } from './AppearanceToggle';
import { SleepToggle } from './SleepToggle';
import { SidebarCollapseIcon } from './icons';
import { setSidebarCollapsed } from './actions';
import type { JSX } from 'react';

const GEAR = { __html: ICONS.gear(18) };

export function SidebarToolbar(): JSX.Element {
  return (
    <div id="sidebar-toolbar">
      <SleepToggle />
      <AppearanceToggle />
      <button
        id="global-settings-btn"
        title="Global settings"
        dangerouslySetInnerHTML={GEAR}
        onClick={() => void openSettings('global')}
      />
      <button id="sidebar-collapse-btn" title="Hide sidebar" onClick={() => setSidebarCollapsed(true)}>
        <SidebarCollapseIcon />
      </button>
    </div>
  );
}
