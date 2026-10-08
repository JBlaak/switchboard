/**
 * The main process, start to finish.
 *
 * Bootstrap only: build the container, register the IPC handlers, open a
 * window, start the background work, and shut it all down cleanly. Every
 * decision this used to make is now behind a service — what is left is the
 * order things happen in, which is the one thing an entry point should own.
 */
import { app, BrowserWindow } from 'electron';
import log from 'electron-log';
import { buildContainer, isolateUserDataIfRequested } from './composition-root';
import { registerIpcHandlers } from './ipc';
import { buildApplicationMenu } from '../infrastructure/electron/app-menu';
import { createMainWindow } from '../infrastructure/electron/main-window';
import { systemTimers } from '../infrastructure/system/timers';
import { normaliseAppearance } from '../domain/settings/appearance';
import type { Container } from './composition-root';

// Must happen before anything reads a path off `app`.
isolateUserDataIfRequested();

log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

// Dev-only live reload. A bare require so the dependency stays out of the
// packaged bundle's import graph; esbuild keeps it external.
try {
  require('electron-reloader')(module, { watchRenderer: true });
} catch {
  // Not installed, or a packaged build.
}

/**
 * Only one instance may run.
 *
 * Replacing the AppImage while Switchboard is running makes the OS spawn the
 * new binary, which would otherwise initialise a second process and leave the
 * first one's sessions orphaned or killed. The second launch quits immediately;
 * the first brings its window to the front.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main(): void {
  const container = buildContainer();

  app.on('second-instance', () => {
    const window = container.getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  // Listening at all is the point: without a listener Electron quits when the
  // last window closes, and a Mac app stays running in the Dock instead.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    container.projectsWatcher.stop();
    container.lifecycle.terminateAll();
  });

  // After the windows are gone, so nothing is mid-query when the handle closes.
  app.on('will-quit', () => container.close());

  void app.whenReady().then(() => start(container));
}

function start(container: Container): void {
  registerIpcHandlers(container);
  buildApplicationMenu();

  // Before the window: the chrome's overlay colours are picked at creation, and
  // a renderer that first paints in the wrong scheme flashes on every launch.
  container.appearance.apply(normaliseAppearance(container.settings.global().appearance));
  openWindow(container);

  container.projectsWatcher.start();
  container.schedules.ensureCreatorCommand();
  container.schedules.start();

  // A migration that recreated the search index leaves it empty even though the
  // session cache is intact, so the index alone has to be refilled.
  if (container.searchIndex.wasRecreated()) container.sessionIndex.rebuild();

  // macOS keeps the app alive after its last window closes.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow(container);
  });
}

function openWindow(container: Container): void {
  const window = createMainWindow({
    timers: systemTimers,
    appDir: __dirname,
    savedBounds: () => container.settings.global().windowBounds,
    saveBounds: (bounds) => container.settings.updateGlobal((settings) => {
      settings.windowBounds = bounds;
    }),
    onFullscreenChanged: (isFullscreen) => container.renderer.fullscreenChanged(isFullscreen),
    onClosed: () => {
      // On macOS the app stays in the dock after its last window closes. Kill
      // the sessions anyway: orphaned `claude` processes would otherwise
      // accumulate in the background with no way for the user to reach them.
      container.lifecycle.terminateAll();
      container.setWindow(null);
    },
  });
  container.setWindow(window);
}
