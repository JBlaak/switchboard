/**
 * Building and keeping the main window.
 *
 * Most of this is not layout but *containment*: a renderer that runs untrusted
 * terminal output has several ways to navigate itself somewhere or open a child
 * window, and each of them is intercepted so a link in a session's output opens
 * in the user's browser instead of replacing the app.
 */
import {BrowserWindow, screen, shell} from 'electron';
import path from 'node:path';
import {isReloadShortcut} from './support/reload-shortcut';
import {boundsToSave, MIN_BOUNDS, restorableBounds} from './support/window-bounds';
import {windowChromeOptions} from './support/window-chrome';
import type {WindowBounds} from '../../domain/settings/settings';
import type {Timers} from '../../application/ports/clock';

/** How long to wait after a move or resize before saving the geometry. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * The renderer's `window.open`, swapped for one that sends web links to the
 * user's browser.
 *
 * xterm's link addon opens a blank window first and only then points it at the
 * link, by setting `location.href` on what `window.open()` returned. So the
 * replacement hands back a stand-in whose `location.href` does the opening.
 * It has to be a script in the page, not a window-open handler in this
 * process: the addon uses the return value, which a handler cannot provide.
 *
 * Wrapped in a function called on the spot, so the script evaluates to
 * undefined: `executeJavaScript` would otherwise try to send the new
 * `window.open` back to this process.
 */
const WINDOW_OPEN_SHIM = `(() => {
    const openIfWebLink = (url) => {
        if (typeof url !== 'string' || !/^https?:[/][/]/i.test(url)) return false;
        window.api.openExternal(url);
        return true;
    };
    window.open = (url) => {
        if (openIfWebLink(url)) return null;
        return {location: {set href(target) { openIfWebLink(target); }}};
    };
})();`;

/** The e2e harness asked for a window that never appears on screen. */
export function hiddenForE2e(): boolean {
    return process.env.SWITCHBOARD_E2E === '1' && process.env.SWITCHBOARD_E2E_HIDDEN === '1';
}

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
    /** The window got focus: the user is back. */
    onFocus?(): void;
    /** Every session's process has to go when the last window does. */
    onClosed(): void;
    /** Directory holding the built bundles — preload, renderer, icon. */
    appDir: string;
    /**
     * Show it without making it, or the app, active: Quick Ask opens it to start
     * a session while the user stays where they are (R4).
     */
    inactive?: boolean;
}

export function createMainWindow(deps: MainWindowDeps): BrowserWindow {
    const bounds = restorableBounds(deps.savedBounds(), screen.getAllDisplays());

    const window = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        ...MIN_BOUNDS,
        // The e2e harness sizes the window to its baselines, which on a CI Mac's
        // small virtual display would otherwise be clipped to the work area.
        ...(process.env.SWITCHBOARD_E2E === '1' ? {enableLargerThanScreen: true} : {}),
        // The e2e suite runs a few apps at once; shown, they would flash over the
        // desktop of whoever runs it. Hidden, the page still lays out and paints,
        // so Playwright's input and screenshots work the same.
        ...(hiddenForE2e() || deps.inactive ? {show: false} : {}),
        title: 'Switchboard',
        icon: path.join(deps.appDir, '..', 'build', 'icon.png'),
        ...windowChromeOptions(),
        webPreferences: {
            preload: path.join(deps.appDir, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            // A hidden window is otherwise throttled like a background tab: its
            // timers slow down and its animation frames stop.
            ...(hiddenForE2e() ? {backgroundThrottling: false} : {}),
        },
    });

    // Set after construction: passing x/y to the constructor lets macOS clamp the
    // size to fit the display the position lands on.
    if (bounds.position) {
        window.setBounds({...bounds.position, width: bounds.width, height: bounds.height});
    }

    if (deps.inactive && !hiddenForE2e()) window.once('ready-to-show', () => window.showInactive());
    void window.loadFile(path.join(deps.appDir, 'renderer', 'index.html'));

    containNavigation(window);
    // This window's alone: the shim opens links through `window.api`.
    window.webContents.on('did-finish-load', () => {
        void window.webContents.executeJavaScript(WINDOW_OPEN_SHIM);
    });
    trackBounds(window, deps);
    reportFullscreen(window, deps);

    window.on('closed', deps.onClosed);

    return window;
}

/** Keep the renderer inside itself. The Quick Ask pop-up is held the same way. */
export function containNavigation(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(({url}) => {
        if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {});
        return {action: 'deny'};
    });

    window.webContents.on('will-navigate', (event, url) => {
        if (url === window.webContents.getURL()) return;
        event.preventDefault();
        if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {});
    });

    window.webContents.on('before-input-event', (event, input) => {
        if (isReloadShortcut(input)) event.preventDefault();
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
    window.on('focus', () => deps.onFocus?.());
}
