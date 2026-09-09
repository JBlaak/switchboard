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
 * block. Kept in sync with `--sb-bg-panel` / `--sb-text-muted`.
 */
import type { BrowserWindowConstructorOptions } from 'electron';

const CHROME_BG = '#1b1d21';
const CHROME_SYMBOL = '#9a9a9c';

/** The height the overlay reserves, matching the app's own header strip. */
const OVERLAY_HEIGHT = 40;

/**
 * Per-platform frameless options.
 *
 * Anything unrecognised falls back to the native title bar rather than shipping
 * a window with no way to close it.
 */
export function windowChromeOptions(
  platform: NodeJS.Platform = process.platform,
): Partial<BrowserWindowConstructorOptions> {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      // Vertically centred in the 44px strip the headers reserve for it.
      trafficLightPosition: { x: 18, y: 15 },
    };
  }
  if (platform === 'win32' || platform === 'linux') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: CHROME_BG, symbolColor: CHROME_SYMBOL, height: OVERLAY_HEIGHT },
    };
  }
  return {};
}
