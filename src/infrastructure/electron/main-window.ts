/**
 * Building and keeping the main window.
 *
 * Most of this is not layout but *containment*: a renderer that runs untrusted
 * terminal output has several ways to navigate itself somewhere or open a child
 * window, and each of them is intercepted so a link in a session's output opens
 * in the user's browser instead of replacing the app.
 */
import { BrowserWindow, screen, shell } from 'electron';
import path from 'node:path';
import { boundsToSave, MIN_BOUNDS, restorableBounds } from './window-bounds';
import { windowChromeOptions } from './window-chrome';
import type { WindowBounds } from '../../domain/settings/settings';
import type { Timers } from '../../application/ports/clock';

/** How long to wait after a move or resize before saving the geometry. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Replace `window.open` in the renderer.
 *
 * xterm's link addon opens a link by calling `window.open()` and then setting
 * `location.href` on what it gets back. Both have to be intercepted, so it is
 * handed a proxy whose `location.href` setter routes through the app's own
 * "open externally" path. Injected as a script rather than handled natively
 * because the addon reads the return value.
 */
const WINDOW_OPEN_SHIM = `
  window.open = function(url) {
    if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
    const proxy = {};
    Object.defineProperty(proxy, 'location', { get() {
      const loc = {};
      Object.defineProperty(loc, 'href', {
        set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
      });
      return loc;
    }});
    return proxy;
  };
  void 0;
`;

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export interface MainWindowDeps {
  timers: Timers;
  /** The geometry to reopen at, from settings. */
  savedBounds(): WindowBounds | undefined;
  /** Persist the geometry; called debounced, and once more on close. */
  saveBounds(bounds: WindowBounds): void;
  onFullscreenChanged(isFullscreen: boolean): void;
  /** Every session's process has to go when the last window does. */
  onClosed(): void;
  /** Directory holding the built bundles — preload, renderer, icon. */
  appDir: string;
}

export function createMainWindow(deps: MainWindowDeps): BrowserWindow {
  const bounds = restorableBounds(deps.savedBounds(), screen.getAllDisplays());

  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...MIN_BOUNDS,
    title: 'Switchboard',
    icon: path.join(deps.appDir, '..', 'build', 'icon.png'),
    ...windowChromeOptions(),
    webPreferences: {
      preload: path.join(deps.appDir, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Set after construction: passing x/y to the constructor lets macOS clamp the
  // size to fit the display the position lands on.
  if (bounds.position) {
    window.setBounds({ ...bounds.position, width: bounds.width, height: bounds.height });
  }

  void window.loadFile(path.join(deps.appDir, 'renderer', 'index.html'));

  containNavigation(window);
  trackBounds(window, deps);
  reportFullscreen(window, deps);

  window.on('closed', deps.onClosed);

  return window;
}

/** Keep the renderer inside itself. */
function containNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return;
    event.preventDefault();
    if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {});
  });

  window.webContents.on('did-finish-load', () => {
    void window.webContents.executeJavaScript(WINDOW_OPEN_SHIM);
  });

  // Chromium's built-in reload shortcuts would throw away every terminal on
  // screen. Ctrl+R alone is deliberately left alone on macOS, where it is not
  // a reload shortcut and belongs to the shell's reverse-i-search.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
  });
}

function trackBounds(window: BrowserWindow, deps: MainWindowDeps): void {
  let timer: unknown = null;

  const save = (): void => {
    deps.timers.clearTimeout(timer);
    timer = deps.timers.setTimeout(() => {
      const bounds = boundsToSave(window);
      if (bounds) deps.saveBounds(bounds);
    }, SAVE_DEBOUNCE_MS);
  };

  window.on('resize', save);
  window.on('move', save);

  // The debounce may not have fired by the time the window goes.
  window.on('close', () => {
    deps.timers.clearTimeout(timer);
    const bounds = boundsToSave(window);
    if (bounds) deps.saveBounds(bounds);
  });
}

/**
 * Tell the renderer about fullscreen.
 *
 * macOS hides the traffic lights in fullscreen, so the space the headers
 * reserve for them becomes a dead gap the renderer should reclaim.
 */
function reportFullscreen(window: BrowserWindow, deps: MainWindowDeps): void {
  window.on('enter-full-screen', () => deps.onFullscreenChanged(true));
  window.on('leave-full-screen', () => deps.onFullscreenChanged(false));
}
