/**
 * What the settings panel does outside its own form: reading and writing the
 * stored settings, applying them to the rest of the app, and swapping the
 * panel in for the terminal or the empty screen.
 *
 * The swap stays imperative: the terminal area, the placeholder and the panel
 * are containers in `index.html` shown and hidden by style, and a terminal can
 * only be refitted once it has a layout box again — which has to be true
 * synchronously, before `refitOpenTerminals` runs, not whenever React next
 * commits.
 */
import { loadProjects } from '../../features/sessions/session-list';
import { relayoutSessionList } from '../session-list/relayout';
import { placeholder, settingsViewer, terminalArea, terminalHeader } from '../../lib/dom';
import { dispatch } from '../../state/app-store';
import { openSessions, view } from '../../state/session-store';
import { showEmptyScreen } from '../../features/patch/patch';
import { syncQuickSessionButton } from '../../features/sessions/quick-session';
import { applyTerminalFont, refitOpenTerminals } from '../../features/terminal/terminal-manager';
import { applyTerminalTheme } from '../../features/terminal/terminal-themes';
import type { SettingsRecord, SettingsScope } from '../../state/settings-slice';
import type { ShellProfile } from '../../../domain/shell/shell-profile';
import type { WeatherLocation } from '../../../domain/weather/weather';

/** The last open asked for: a slower, earlier one that lands after it is dropped. */
let latestOpen = 0;

/** Read what the scope stores, then show the panel in place of the main area. */
export async function openSettings(scope: SettingsScope, projectPath?: string): Promise<void> {
  const token = ++latestOpen;
  const isProject = scope === 'project';
  const settingsKey = isProject ? 'project:' + projectPath : 'global';
  const [current, globalSettings, shellProfiles, appVersion, quickAsk] = await Promise.all([
    window.api.getSetting<SettingsRecord>(settingsKey).then(found => found || {}),
    isProject
      ? window.api.getSetting<SettingsRecord>('global').then(found => found || {})
      : Promise.resolve({}),
    window.api.getShellProfiles().catch((): ShellProfile[] => []),
    isProject ? Promise.resolve(null) : window.api.getAppVersion().catch(() => null),
    // Unknown counts as held: the "in use" line only shows on a refusal main reported.
    window.api.quickAskHotkeyStatus().catch(() => ({ registered: true })),
  ]);
  if (token !== latestOpen) return;

  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  settingsViewer.style.display = 'flex';
  dispatch({
    type: 'settingsOpened',
    scope,
    projectPath: isProject ? projectPath ?? null : null,
    current,
    globalSettings,
    shellProfiles,
    appVersion,
    quickAskRegistered: quickAsk.registered,
  });
}

/** Close the panel and put back what it covered: the open terminal, or the empty screen. */
export function closeSettings(): void {
  settingsViewer.style.display = 'none';
  dispatch({ type: 'settingsClosed' });
  const { activeSessionId } = view;
  if (activeSessionId && openSessions.has(activeSessionId)) {
    terminalArea.style.display = '';
    terminalHeader.style.display = '';
  } else {
    showEmptyScreen();
  }
  // Terminals had no layout box while the panel covered them, so anything that
  // changed their metrics in the meantime (font size, line height) could not fit
  // itself and would leave output running off the right edge until the next resize.
  refitOpenTerminals();
}

/**
 * Store what the form holds, apply it, and close after a moment.
 *
 * Global settings are merged over what is stored, so keys the form does not
 * manage (the window bounds, remote projects, the appearance) survive. A
 * project's blob is replaced outright: a field left on "Use global default" is
 * one the project no longer overrides.
 */
export async function saveSettings(
  scope: SettingsScope, projectPath: string | null, form: Record<string, unknown>,
): Promise<void> {
  const isProject = scope === 'project';
  const settingsKey = isProject ? 'project:' + projectPath : 'global';
  const settings: Record<string, any> = isProject
    ? form
    : { ...((await window.api.getSetting<SettingsRecord>('global')) || {}), ...form };

  await window.api.setSetting(settingsKey, settings);

  if (!isProject) {
    if (settings.visibleSessionCount) view.visibleSessionCount = settings.visibleSessionCount;
    if (settings.sessionMaxAgeDays) view.sessionMaxAgeDays = settings.sessionMaxAgeDays;
    if (settings.terminalTheme) applyTerminalTheme(settings.terminalTheme);
    applyTerminalFont({
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      lineHeight: settings.terminalLineHeight,
    });
    relayoutSessionList();
    void syncQuickSessionButton();
  }

  dispatch({ type: 'settingsSaved' });
  setTimeout(() => closeSettings(), 600);
}

/**
 * Hide a project from Switchboard, after asking. Its session files stay on
 * disk; it just stops being listed.
 */
export async function hideProject(projectPath: string, shortName: string): Promise<void> {
  if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
  await window.api.removeProject(projectPath);
  settingsViewer.style.display = 'none';
  dispatch({ type: 'settingsClosed' });
  showEmptyScreen();
  void loadProjects();
}

/** Look a weather city up. Null when there is no such place. */
export function geocodeCity(name: string): Promise<WeatherLocation | null> {
  return window.api.geocodeWeatherLocation(name);
}
