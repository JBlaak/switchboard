/**
 * Starting the renderer.
 *
 * Read it top to bottom: install the wiring, apply the stored preferences, then
 * fetch and restore. The order is the only thing here that matters —
 * `installSidebar` has to register the two refresh events before anything can
 * fire one, and the stored terminal font has to be applied before a restored
 * session opens a terminal in the wrong one.
 */
import { installLayout } from './layout';
import { installIpcListeners } from './ipc-listeners';
import { installQuotaGauges } from './quota-gauges';
import { installSearch } from './search';
import { installShortcuts } from './shortcuts';
import { installTabRouter } from './tab-router';
import { installTimeTicker } from './time-ticker';
import { renderStatusSummary } from './status-bar';
import { installSidebar } from '../features/sessions/sidebar';
import { installSidebarFilters } from '../features/sessions/sidebar-filters';
import { loadProjects } from '../features/sessions/session-list';
import { openSession } from '../features/sessions/session-actions';
import { confirmAndStopSession } from '../features/sessions/session-actions';
import { schedulePoll } from '../features/sessions/session-poller';
import { terminalStopButton } from '../features/sessions/terminal-header';
import { tickConnectionCards } from '../features/remote/connection-card';
import { setTickListener } from '../state/remote-status-store';
import { openSessions, sessionMap, view } from '../state/session-store';
import { initFilePanel } from '../features/panel/file-panel';
import { initGridObservers, showGridView } from '../features/terminal/grid-view';
import {
  applyTerminalFont, prewarmTerminalRenderer,
} from '../features/terminal/terminal-manager';
import { TERMINAL_THEMES, applyTerminalTheme } from '../features/terminal/terminal-themes';
import type { GlobalSettings } from '../../domain/settings/settings';

export function bootstrap(): void {
  // The refresh events, before anything can fire one.
  installSidebar();

  installIpcListeners();
  installTabRouter();
  installLayout();
  installSidebarFilters();
  installSearch();
  installShortcuts();
  installTimeTicker();
  installQuotaGauges();

  initGridObservers();
  initFilePanel();
  setTickListener(tickConnectionCards);

  terminalStopButton.addEventListener('click', () => {
    if (view.activeSessionId) void confirmAndStopSession(view.activeSessionId);
  });

  schedulePoll();
  prewarmTerminalRenderer();

  void applyStoredSettings();
  void loadProjects().then(() => {
    renderStatusSummary();
    restoreView();
  });
}

/**
 * Apply the preferences that shape the terminals.
 *
 * Applied rather than just assigned: session restore can open a terminal before
 * this async read resolves, and that one needs the stored font too.
 */
async function applyStoredSettings(): Promise<void> {
  const global = await window.api.getSetting<GlobalSettings>('global');
  if (!global) return;

  if (global.sidebarWidth) {
    document.getElementById('sidebar')!.style.width = global.sidebarWidth + 'px';
  }
  if (global.visibleSessionCount) view.visibleSessionCount = Number(global.visibleSessionCount);
  if (global.sessionMaxAgeDays) view.sessionMaxAgeDays = Number(global.sessionMaxAgeDays);

  const theme = global.terminalTheme as string | undefined;
  if (theme && theme in TERMINAL_THEMES) applyTerminalTheme(theme);

  applyTerminalFont({
    fontFamily: global.terminalFontFamily as string | undefined,
    fontSize: global.terminalFontSize as number | undefined,
    lineHeight: global.terminalLineHeight as number | undefined,
  });
}

/**
 * Put the window back the way the user left it.
 *
 * The grid preference is restored before any session opens, so a restored
 * session enters grid mode rather than being opened full-width and then moved.
 *
 * A remote session is only reopened when it is still connected: reconnecting
 * may need auth the user is not looking at (host key prompts, 1Password
 * approval), so it waits for a click.
 */
function restoreView(): void {
  if (view.gridViewActive) showGridView();

  const sessionId = view.activeSessionId;
  if (!sessionId || openSessions.has(sessionId)) return;

  const session = sessionMap.get(sessionId);
  if (!session) return;
  if (session.type === 'remote' && !view.activePtyIds.has(sessionId)) return;

  void openSession(session);
}
