/**
 * The smallest store the renderer needs: one state value, one reducer, and
 * listeners told about every transition.
 *
 * Written here rather than taken from a library because the whole contract is
 * three functions, and because it has to serve two kinds of reader at once —
 * React components through `useSyncExternalStore`, and the vanilla modules that
 * have not moved yet, which want to know exactly what changed. That is why a
 * listener is handed the event and the state on both sides of it, not just a
 * nudge to go and look.
 *
 * Nothing in this file knows about React or the DOM, so it runs under the node
 * test runner as it is.
 */

export type Reducer<S, E> = (state: S, event: E) => S;

/** Called after each transition, in the order the listeners subscribed. */
export type Listener<S, E> = (state: S, previous: S, event: E) => void;

export interface Store<S, E> {
  getState(): S;
  dispatch(event: E): void;
  /** Answers the unsubscribe. */
  subscribe(listener: Listener<S, E>): () => void;
}

/**
 * A store over `reducer`, starting at `initial`.
 *
 * Two rules keep the listeners honest:
 *
 * - Every event is delivered, including one the reducer answered with the same
 *   state. Some pushes change nothing and are only prompts to act — a status
 *   line, a process exit, the project list changing on disk — and their
 *   handlers subscribe here like everyone else. A reader that only cares about
 *   state compares `state` with `previous` by identity, which is what the
 *   reducers preserve when nothing changed; `useSyncExternalStore` does that
 *   for itself.
 * - A dispatch made from inside a listener is reduced at once (so `getState`
 *   is never behind), but its notification waits until the current round has
 *   reached every listener. Each listener therefore sees every transition, in
 *   order, and the `state` it is handed is always the one its `previous`
 *   turned into — a listener that applies differences cannot apply them out of
 *   order.
 */
export function createStore<S, E>(reducer: Reducer<S, E>, initial: S): Store<S, E> {
  let state = initial;
  const listeners = new Set<Listener<S, E>>();
  const queue: { next: S; previous: S; event: E }[] = [];
  let notifying = false;

  function dispatch(event: E): void {
    const previous = state;
    const next = reducer(previous, event);
    state = next;
    queue.push({ next, previous, event });
    if (notifying) return;

    notifying = true;
    try {
      while (queue.length) {
        const transition = queue.shift()!;
        // A snapshot, so a listener that unsubscribes another mid-round does
        // not skip a third.
        for (const listener of [...listeners]) {
          listener(transition.next, transition.previous, transition.event);
        }
      }
    } finally {
      notifying = false;
      // A listener that threw leaves the rest of its round undelivered; the
      // next dispatch must not inherit it.
      queue.length = 0;
    }
  }

  return {
    getState: () => state,
    dispatch,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/**
 * A selector that answers the same value until the selection really changes.
 *
 * `useSyncExternalStore` compares snapshots by identity, so a selector that
 * builds a fresh object or array each call would make every read look like a
 * change and re-render forever. This remembers the last state and the last
 * selection: the same state answers the same value without calling the
 * selector at all, and a new state whose selection `isEqual` the last one
 * answers the last one again.
 *
 * `seed` carries a previous selection over, so swapping the selector function
 * (an inline arrow re-created each render) does not by itself count as a
 * change.
 */
export function memoSelector<S, T>(
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
  seed?: { value: T },
): (state: S) => T {
  let hasState = false;
  let lastState: S;
  let hasValue = seed !== undefined;
  let lastValue = seed?.value as T;

  return (state: S): T => {
    if (hasState && Object.is(state, lastState)) return lastValue;
    const next = selector(state);
    hasState = true;
    lastState = state;
    if (hasValue && isEqual(lastValue, next)) return lastValue;
    hasValue = true;
    lastValue = next;
    return next;
  };
}

/** Equality for a selection that is a flat object or array of values. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}
