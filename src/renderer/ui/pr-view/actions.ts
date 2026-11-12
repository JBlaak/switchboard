/**
 * Every link in the app comes through `openLink`, pull requests included:
 * each goes to the browser. One door, so a new place that shows links only
 * has to call it.
 */

/** Follow a link in the browser. */
export function openLink(url: string): void {
    void window.api.openExternal(url);
}
