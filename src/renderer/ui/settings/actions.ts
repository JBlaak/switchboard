/**
 * What the global settings panel does outside its own form: reading and
 * writing the stored settings, applying them to the rest of the app, and
 * opening and closing the panel. A project's own settings are on its page
 * (`ui/project-page/settings-actions`, #176).
 *
 * The panel is swapped in for the terminal or the empty screen by the main
 * area's route (`ui/main-area/install-main-area`), synchronously as the open
 * or close is dispatched, so the terminals have their layout box back before
 * `refitOpenTerminals` runs.
 */
import { relayoutSessionList } from '../session-list/relayout';
import { dispatch } from '../../state/app-store';
import { view } from '../../state/session-store';
import { syncQuickSessionButton } from '../../features/sessions/quick-session';
import { applyTerminalFont, refitOpenTerminals } from '../../features/terminal/terminal-manager';
import { applyTerminalTheme } from '../../features/terminal/terminal-themes';
import type { SettingsRecord } from '../../state/settings-slice';
import type { ShellProfile } from '../../../domain/shell/shell-profile';
import type { WeatherLocation } from '../../../domain/weather/weather';

/** The last open asked for: a slower, earlier one that lands after it is dropped. */
let latestOpen = 0;

/** Read what is stored, then show the panel in place of the main area. */
export async function openSettings(): Promise<void> {
  const token = ++latestOpen;
  const [current, shellProfiles, appVersion, quickAsk] = await Promise.all([
    window.api.getSetting<SettingsRecord>('global').then(found => found || {}),
    window.api.getShellProfiles().catch((): ShellProfile[] => []),
    window.api.getAppVersion().catch(() => null),
    // Unknown counts as held: the "in use" line only shows on a refusal main reported.
    window.api.quickAskHotkeyStatus().catch(() => ({ registered: true, missing: [] })),
  ]);
  if (token !== latestOpen) return;

  dispatch({
    type: 'settingsOpened',
    current,
    shellProfiles,
    appVersion,
    quickAskRegistered: quickAsk.registered,
    quickAskMissing: quickAsk.missing,
  });
}

/** Close the panel and put back what it covered: the session to return to, or the empty screen. */
export function closeSettings(): void {
  dispatch({ type: 'settingsClosed' });
  // Terminals had no layout box while the panel covered them, so anything that
  // changed their metrics in the meantime (font size, line height) could not fit
  // itself and would leave output running off the right edge until the next resize.
  refitOpenTerminals();
}

/**
 * Store what the form holds, apply it, and close after a moment.
 *
 * Merged over what is stored, so keys the form does not manage (the window
 * bounds, remote projects, the appearance) survive.
 */
export async function saveSettings(form: Record<string, unknown>): Promise<void> {
  const settings: Record<string, any> = {
    ...((await window.api.getSetting<SettingsRecord>('global')) || {}),
    ...form,
  };

  await window.api.setSetting('global', settings);

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

  dispatch({ type: 'settingsSaved' });
  setTimeout(() => closeSettings(), 600);
}

/** Look a weather city up. Null when there is no such place. */
export function geocodeCity(name: string): Promise<WeatherLocation | null> {
  return window.api.geocodeWeatherLocation(name);
}

/**
 * Whether a server in `~/.claude.json` has this BlaakTasks URL (#252).
 * Unknown counts as yes: the "add it" line only shows on a no main gave.
 */
export function blaakTasksSetUp(url: string): Promise<boolean> {
  return window.api.blaakTasksSetUp(url).catch(() => true);
}
