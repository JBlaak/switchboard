/**
 * The Session work page's work outside React: telling main when it closes,
 * the clock its "updated Xs ago" runs on, fetching the selected item's diff,
 * and keeping the image cards' defaults (`image-defaults`).
 *
 * It follows the store rather than the actions, because the page closes for
 * reasons of its own slice (another session on screen, the screen cleared,
 * the settings panel or a project opening) as well as on Esc, Back and Cmd+G,
 * and every one of them has to tell main the same way. Swapping the page in
 * for the terminal and back follows the main area's route
 * (`ui/main-area/install-main-area`).
 */
import { dispatch, store } from '../../state/app-store';
import { diffToLoad } from '../../state/session-work-slice';
import { loadDiff } from './actions';
import { installImageDefaults } from './image-defaults';

/** How often "updated Xs ago" moves on while the page is open. */
const TICK_MS = 1000;

/** Start following the page. Answers a teardown. */
export function installSessionWork(): () => void {
  let tick: ReturnType<typeof setInterval> | null = null;
  const stopImageDefaults = installImageDefaults();

  const unsubscribe = store.subscribe((state, previous) => {
    // The selected item's diff, asked for once it is selected and again when
    // a snapshot changes it (D8: lazily, never the whole page's at once).
    const page = state.sessionWork.page;
    if (page && page !== previous.sessionWork.page) {
      const wanted = diffToLoad(page);
      if (wanted) void loadDiff(page.sessionId, wanted.itemId, wanted.key);
    }

    const was = previous.sessionWork.page?.sessionId ?? null;
    const now = state.sessionWork.page?.sessionId ?? null;
    if (was === now) return;

    if (was) window.api.closeSessionWork(was);
    if (now) {
      tick ??= setInterval(() => dispatch({ type: 'sessionWorkTicked', at: Date.now() }), TICK_MS);
    } else {
      if (tick) clearInterval(tick);
      tick = null;
    }
  });

  return () => {
    if (tick) clearInterval(tick);
    unsubscribe();
    stopImageDefaults();
  };
}
