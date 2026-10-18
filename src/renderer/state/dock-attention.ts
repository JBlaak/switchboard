/**
 * Telling main how many sessions need input, so the dock icon can bounce.
 *
 * A service that follows the store: the count is the sidebar's Needs input
 * block — sessions blocked on the user, and sessions asking questions — and it
 * is sent only when it changes. What the dock does with it is main's business
 * (see `infrastructure/electron/dock-attention`).
 */
import { askingCountIn } from './questions-slice';
import type { RendererEvent } from './events';
import type { RendererState } from './root';
import type { Store } from './store';

/** The sessions the Needs input block holds, by the same rule as `rowActivity`. */
export function needsInputCount(state: RendererState): number {
  const ids = new Set(Object.keys(state.activity.attention));
  for (const sessionId of Object.keys(state.questions.bySession)) {
    if (askingCountIn(state.questions, sessionId) > 0) ids.add(sessionId);
  }
  return ids.size;
}

/** Report the count off `store` through `send`. Answers a function that stops it. */
export function installDockAttention(
  store: Store<RendererState, RendererEvent>,
  send: (count: number) => void,
): () => void {
  let sent = 0;
  const sync = (state: RendererState): void => {
    const count = needsInputCount(state);
    if (count === sent) return;
    sent = count;
    send(count);
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (state.activity.attention !== previous.activity.attention
      || state.questions !== previous.questions) sync(state);
  });
  sync(store.getState());
  return unsubscribe;
}
