/**
 * Where the pointer opens the session tray: the bar above the terminal, the
 * tray itself, and the top of the terminal under them, so the tray does not
 * need the bar's "hover for tools" label to be found.
 */

/** How far down the terminal, from its top edge, hovering opens the tray. */
export const TRAY_ZONE_PX = 100;

/** The terminal's box on screen, as `getBoundingClientRect` gives it. */
export interface ZoneRect {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}

/** Whether a point lies in the top `TRAY_ZONE_PX` of the terminal. */
export function inTerminalTopZone(x: number, y: number, terminal: ZoneRect): boolean {
    if (terminal.bottom <= terminal.top || terminal.right <= terminal.left) return false;
    return (
        x >= terminal.left &&
        x < terminal.right &&
        y >= terminal.top &&
        y < Math.min(terminal.bottom, terminal.top + TRAY_ZONE_PX)
    );
}
