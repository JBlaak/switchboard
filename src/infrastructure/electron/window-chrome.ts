/**
 * The frameless window's chrome.
 *
 * Switchboard's own sidebar and terminal headers fill the strip the native
 * title bar used to occupy, so the window is frameless — but the traffic
 * lights stay native and sit on top of that strip. Which is why the renderer
 * marks the header areas as drag regions: otherwise the window would have
 * nothing left to grab.
 *
 * The window is backed by the system's sidebar material and the page itself is
 * transparent, so the material shows wherever the page doesn't paint. Only the
 * sidebar leaves it showing; the terminal and everything else stay opaque (see
 * _glass.scss). With Reduce Transparency on, macOS draws the material solid.
 */
import type { BrowserWindowConstructorOptions } from 'electron';

export function windowChromeOptions(): Partial<BrowserWindowConstructorOptions> {
  return {
    titleBarStyle: 'hidden',
    // Vertically centred in the 44px strip the headers reserve for it.
    trafficLightPosition: { x: 18, y: 15 },
    vibrancy: 'sidebar',
    backgroundColor: '#00000000',
  };
}
