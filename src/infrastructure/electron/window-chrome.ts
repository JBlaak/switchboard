/**
 * The frameless window's chrome.
 *
 * Switchboard's own sidebar and terminal headers fill the strip the native
 * title bar used to occupy, so the window is frameless — but the traffic
 * lights stay native and sit on top of that strip. Which is why the renderer
 * marks the header areas as drag regions: otherwise the window would have
 * nothing left to grab.
 */
import type { BrowserWindowConstructorOptions } from 'electron';

export function windowChromeOptions(): Partial<BrowserWindowConstructorOptions> {
  return {
    titleBarStyle: 'hidden',
    // Vertically centred in the 44px strip the headers reserve for it.
    trafficLightPosition: { x: 18, y: 15 },
  };
}
