/**
 * The timer behind the shared countdown clock.
 *
 * A service that follows the store and dispatches: while some connection is
 * in flight it dispatches `remoteTick` once a second, and it stops as soon as
 * none is. Whether anything is in flight only changes with the statuses, so
 * it re-checks after every event that changed them and nowhere else — no
 * caller has to remember to start or stop it.
 *
 * The cards and the terminal header re-render off `tickAt`; nothing here
 * knows what they show.
 */
import { sessionsInFlightIn } from './remote-slice';
import type { RendererEvent } from './events';
import type { RendererState } from './root';
import type { Store } from './store';

/** How often the countdowns are repainted. */
export const REMOTE_TICK_MS = 1000;

/** Run the ticker off `store`. Answers a function that stops it for good. */
export function installRemoteTicker(store: Store<RendererState, RendererEvent>): () => void {
  let ticker: ReturnType<typeof setInterval> | null = null;

  const sync = (state: RendererState): void => {
    const live = sessionsInFlightIn(state.remote).length > 0;
    if (live && !ticker) {
      ticker = setInterval(() => store.dispatch({ type: 'remoteTick', at: Date.now() }), REMOTE_TICK_MS);
    } else if (!live && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.remote.statuses !== previous.remote.statuses) sync(state);
  });
  sync(store.getState());

  return () => {
    unsubscribe();
    if (ticker) clearInterval(ticker);
    ticker = null;
  };
}
