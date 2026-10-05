/**
 * The frameless window's chrome.
 *
 * Switchboard's own sidebar and terminal headers fill the strip the native
 * title bar used to occupy, so the window is frameless — but the *controls*
 * stay native and sit on top of that strip. Which is why the renderer insets
 * around them per platform and marks the header areas as drag regions:
 * otherwise the window would have nothing left to grab.
 *
 * The colours are duplicated from the stylesheet on purpose. On Windows and
 * Linux the controls are painted into an overlay Electron owns, and it has to
 * be given the same colour as the sidebar behind it or it shows as a lighter
 * (or, in light mode, darker) block. CSS cannot reach that overlay, so it does
 * not follow `prefers-color-scheme` on its own: it is picked from
 * `nativeTheme.shouldUseDarkColors` at creation and repainted whenever
 * `nativeTheme` reports a change. Kept in sync with `--sb-bg-panel` /
 * `--sb-text-muted` in both palettes of `_tokens.scss`.
 */
import { nativeTheme } from 'electron';
import type { BrowserWindow, BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron';

const CHROME_DARK = { bg: '#1c1d20', symbol: '#a09e99' };
const CHROME_LIGHT = { bg: '#f0f3f8', symbol: '#626b78' };

/** The height the overlay reserves, matching the app's own header strip. */
const OVERLAY_HEIGHT = 40;

/** Only these platforms paint the controls into an overlay we colour. */
function hasTitleBarOverlay(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'linux';
}

function titleBarOverlay(dark: boolean): TitleBarOverlay {
  const chrome = dark ? CHROME_DARK : CHROME_LIGHT;
  return { color: chrome.bg, symbolColor: chrome.symbol, height: OVERLAY_HEIGHT };
}

/**
 * Per-platform frameless options.
 *
 * Anything unrecognised falls back to the native title bar rather than shipping
 * a window with no way to close it.
 */
export function windowChromeOptions(
  platform: NodeJS.Platform = process.platform,
  dark: boolean = nativeTheme.shouldUseDarkColors,
): Partial<BrowserWindowConstructorOptions> {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      // Vertically centred in the 44px strip the headers reserve for it.
      trafficLightPosition: { x: 18, y: 15 },
    };
  }
  if (hasTitleBarOverlay(platform)) {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarOverlay(dark),
    };
  }
  return {};
}

/**
 * Repaint the overlay when the colour scheme changes.
 *
 * Fires both for the in-app toggle (which sets `themeSource`) and for the OS
 * flipping while the app follows it. macOS draws its traffic lights natively
 * and needs nothing. The listener goes with the window: `nativeTheme` outlives
 * it, and a stale one would call into a destroyed window.
 */
export function followColorScheme(
  window: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!hasTitleBarOverlay(platform)) return;
  const repaint = (): void => {
    if (window.isDestroyed()) return;
    window.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors));
  };
  nativeTheme.on('updated', repaint);
  window.on('closed', () => nativeTheme.off('updated', repaint));
}
