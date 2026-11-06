/**
 * The top row of the sidebar header: the connected phone (#194), sleep, the
 * settings gear with its quick menu (appearance, the Tasks page, all
 * settings) and collapse, right-aligned and level with the traffic lights.
 * The header around it is a window drag region; the buttons opt out in
 * `_chrome.scss`.
 */
import {SleepToggle} from './SleepToggle';
import {SettingsMenu} from './SettingsMenu';
import {PhoneIndicator} from '../phone-access/PhoneIndicator';
import {SidebarCollapseIcon} from './icons';
import {setSidebarCollapsed} from './actions';
import type {JSX} from 'react';

export function SidebarToolbar(): JSX.Element {
    return (
        <div id="sidebar-toolbar">
            <PhoneIndicator />
            <SleepToggle />
            <SettingsMenu />
            <button id="sidebar-collapse-btn" title="Hide sidebar" onClick={() => setSidebarCollapsed(true)}>
                <SidebarCollapseIcon />
            </button>
        </div>
    );
}
