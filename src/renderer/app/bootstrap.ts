/**
 * Starting the renderer.
 *
 * Read it top to bottom: install the wiring, mount the React root, apply the
 * stored preferences, then fetch and restore. Two things here depend on the
 * order: the IPC follow-ups subscribe to the store first, and the stored
 * terminal font has to be applied before a restored session opens a terminal
 * in the wrong one.
 */
import { installLayout } from './layout';
import { installIpcBridge } from './ipc-bridge';
import { installIpcListeners } from './ipc-listeners';
import { installShortcuts } from './shortcuts';
import { installSidebarKeyboard } from '../features/sessions/sidebar-keyboard';
import { loadProjects } from '../features/sessions/session-list';
import { openSession } from '../features/sessions/session-actions';
import { schedulePoll } from '../features/sessions/session-poller';
import { installRemoteTicker } from '../state/remote-ticker';
import { installDockAttention } from '../state/dock-attention';
import { dispatch, store } from '../state/app-store';
import { openSessions, sessionMap, view } from '../state/session-store';
import { applyTerminalFont, prewarmTerminalRenderer } from '../features/terminal/terminal-manager';
import { bufferTerminalData } from '../features/terminal/write-buffer';
import { installTerminalProbe } from '../features/terminal/terminal-probe';
import {
  TERMINAL_THEMES, applyTerminalTheme, followColorSchemeInTerminals,
} from '../features/terminal/terminal-themes';
import { installQuestions } from '../ui/questions/actions';
import { mountReactRoot } from '../ui/Root';
import { countRunning } from '../ui/footer/actions';
import { installFooter } from '../ui/footer/install-footer';
import { installToolbar } from '../ui/toolbar/actions';
import { installSessionList } from '../ui/session-list/install-session-list';
import { installSessionWork } from '../ui/session-work/install-session-work';
import { installPlan } from '../ui/session-work/plan/install-plan';
import { installPlanPage } from '../ui/plan-page/install-plan-page';
import type { GlobalSettings } from '../../domain/settings/settings';

export function bootstrap(): void {
  // The IPC follow-ups subscribe first: on a re-key they move the registries
  // outside the store (`rekeyRegistries`) before any later subscriber — the
  // React tree's included, which only subscribes once it mounts — looks the
  // session up under its new id. No push can arrive while this runs, so the
  // bridge itself can go anywhere in it.
  installIpcListeners();
  installIpcBridge(window.api, dispatch, bufferTerminalData);
  installLayout();
  installToolbar();
  installSidebarKeyboard();
  installShortcuts();
  installSessionList();
  installFooter();
  installQuestions();
  installSessionWork();
  installPlan();
  installPlanPage();
  followColorSchemeInTerminals();
  installTerminalProbe();
  // The surfaces that have moved to React portal out of it.
  mountReactRoot();

  installRemoteTicker(store);
  installDockAttention(store, (count) => window.api.setNeedsInputCount(count));

  schedulePoll();
  prewarmTerminalRenderer();

  void applyStoredSettings();
  void loadProjects().then(() => {
    countRunning();
    restoreView();
    // What main held for this window, a Quick Ask launch, can come now (R4).
    window.api.rendererReady();
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
    document.getElementById('sidebar')!.style.setProperty('--sidebar-width', global.sidebarWidth + 'px');
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
 * A remote session is only reopened when it is still connected: reconnecting
 * may need auth the user is not looking at (host key prompts, 1Password
 * approval), so it waits for a click.
 */
function restoreView(): void {
  const sessionId = view.activeSessionId;
  if (!sessionId || openSessions.has(sessionId)) return;

  const session = sessionMap.get(sessionId);
  if (!session) return;
  if (session.type === 'remote' && !view.activePtyIds.has(sessionId)) return;

  void openSession(session);
}
