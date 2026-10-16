/**
 * The footer's work outside React: the fetches at launch, the usage poll and
 * the activity line's linger.
 *
 * Timers live here rather than in the components because what they produce is
 * state — Patch reads the usage rows, and the activity line is cleared by an
 * event like any other change — and because a component's effects run twice
 * under StrictMode, which would double a fetch the usage endpoint rate-limits.
 */
import { dispatch, onEvent } from '../../state/app-store';
import { checkForUpdate, refreshUsage } from './actions';

/** How often the usage windows are re-fetched. */
const USAGE_REFRESH_MS = 5 * 60 * 1000;

/** How long a finished status message stays before the line clears itself. */
const DONE_LINGER_MS = 3000;

/** Start the footer's fetches and timers. Answers a teardown. */
export function installFooter(): () => void {
  void refreshUsage();
  const usagePoll = setInterval(() => void refreshUsage(), USAGE_REFRESH_MS);
  void checkForUpdate();

  // Each status message cancels the last one's linger: anything that arrives
  // replaces what is there, and only a done message clears itself.
  let linger: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = onEvent('statusUpdate', ({ text, kind }) => {
    if (linger) clearTimeout(linger);
    linger = text && kind === 'done'
      ? setTimeout(() => dispatch({ type: 'statusActivityExpired' }), DONE_LINGER_MS)
      : null;
  });

  return () => {
    clearInterval(usagePoll);
    if (linger) clearTimeout(linger);
    unsubscribe();
  };
}
