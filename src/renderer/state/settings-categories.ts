/**
 * The global settings panel's categories: one page each, picked from the
 * list down its left side, so the settings are a handful of short pages
 * rather than one long scroll.
 *
 * Every page stays mounted while the panel is open — the form reads all of
 * them on Save — and only the chosen one shows.
 */

export const SETTINGS_CATEGORIES = [
    {id: 'sessions', label: 'Sessions', hint: 'Launch defaults and what sessions do'},
    {id: 'prompts', label: 'Saved prompts', hint: 'Prompts for the session tray'},
    {id: 'terminal', label: 'Terminal', hint: 'Theme, font and shell'},
    {id: 'appearance', label: 'Appearance', hint: 'Sidebar, weather and Dock icon'},
    {id: 'integrations', label: 'Integrations', hint: 'Tasks, Bugsnag and the Planner'},
    {id: 'remote', label: 'Phone & VMs', hint: 'Phone access and remote machines'},
    {id: 'about', label: 'About', hint: 'Version'},
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]['id'];

/** The page the panel opens on when nobody asked for another. */
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'sessions';
