/**
 * Moving the keyboard into the session tray, from the bar (#343).
 */

/** The tray's element id, for the bar's `aria-controls`. */
export const SESSION_TRAY_ID = 'session-tray';

/** Put the focus on the tray's first control, once it has rendered open. */
export function focusTray(): void {
    requestAnimationFrame(() => {
        document
            .getElementById(SESSION_TRAY_ID)
            ?.querySelector<HTMLElement>('button:not([disabled]), a[href]')
            ?.focus({preventScroll: true});
    });
}

/** Give the focus back to the bar's tools button, as Esc in the tray does. */
export function focusTrayHint(): void {
    document.getElementById('terminal-header-tray-hint')?.focus({preventScroll: true});
}
