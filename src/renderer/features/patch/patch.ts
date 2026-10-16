/**
 * Showing the empty screen, for the vanilla code that does.
 *
 * Patch appears each time the placeholder comes into view (see
 * `ui/patch/EmptyScreenPatch`). Every path that shows the placeholder goes
 * through `showEmptyScreen`, which is what makes "comes into view" a single
 * event rather than a display change scattered across the features; the
 * placeholder itself is still shown and hidden by the vanilla code.
 */
import { dispatch } from '../../state/app-store';
import { placeholder } from '../../lib/dom';

/** Show the empty screen, with Patch coming into view on it. */
export function showEmptyScreen(): void {
  const wasHidden = placeholder.style.display === 'none';
  placeholder.style.display = '';
  if (wasHidden) dispatch({ type: 'emptyScreenShown' });
}
