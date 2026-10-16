/**
 * Showing the empty screen.
 *
 * Patch appears each time the placeholder comes into view (see
 * `ui/patch/EmptyScreenPatch`). Every path that shows the placeholder goes
 * through `showEmptyScreen`, which is what makes "comes into view" a single
 * event rather than a display change scattered across the features. The
 * placeholder itself is shown and hidden by style, like the rest of the main
 * area's panels (see `ui/settings/actions`).
 */
import { dispatch } from '../../state/app-store';
import { placeholder } from '../../lib/dom';

/** Show the empty screen, with Patch coming into view on it. */
export function showEmptyScreen(): void {
  const wasHidden = placeholder.style.display === 'none';
  placeholder.style.display = '';
  if (wasHidden) dispatch({ type: 'emptyScreenShown' });
}
