/**
 * The renderer's one store.
 *
 * Everything that changes state comes through `dispatch`: the IPC bridge for
 * what main pushes, the actions the components call, the adapters in the
 * `*-store` modules for the imperative modules outside React, and the timers.
 * React components read it with `useStore` (see `ui/use-store`); the modules
 * outside React read it through those same adapters, or subscribe with
 * `onEvent` to follow up on one kind of event.
 *
 * Listeners run in the order they subscribed. Where that matters — the IPC
 * follow-ups re-key `openSessions` before anything else looks for the
 * re-keyed session — `bootstrap` installs them in that order.
 */
import { createStore } from './store';
import { initialRendererState, rootReducer } from './root';
import { STORAGE_KEYS, readStored } from './storage';
import type { RendererEvent } from './events';
import type { RendererState } from './root';

export const store = createStore<RendererState, RendererEvent>(
  rootReducer,
  initialRendererState(readStored('sessionStorage', STORAGE_KEYS.activeSessionId)),
);

export const dispatch = store.dispatch;
export const getState = store.getState;

type EventOf<T extends RendererEvent['type']> = Extract<RendererEvent, { type: T }>;

/** Run `handler` after every event of one type, with the state on both sides. */
export function onEvent<T extends RendererEvent['type']>(
  type: T,
  handler: (event: EventOf<T>, state: RendererState, previous: RendererState) => void,
): () => void {
  return store.subscribe((state, previous, event) => {
    if (event.type === type) handler(event as EventOf<T>, state, previous);
  });
}
