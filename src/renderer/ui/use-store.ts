/**
 * Reading the store from a React component.
 *
 * Built on `useSyncExternalStore`, which is what keeps a read consistent across
 * one render and re-renders only when the snapshot changes. The selector is
 * wrapped in `memoSelector`, so a component re-renders when *its* selection
 * changes, not when anything in the store does — and a selector that builds a
 * new object each call is safe as long as it passes an `isEqual` that sees
 * through it (`shallowEqual` for a flat object or array).
 */
import { useRef, useSyncExternalStore } from 'react';
import { memoSelector } from '../state/store';
import { store } from '../state/app-store';
import type { RendererState } from '../state/root';
import type { Store } from '../state/store';

interface Memo<S, T> {
  selector: (state: S) => T;
  isEqual: ((a: T, b: T) => boolean) | undefined;
  select: (state: S) => T;
  /** The last value `select` answered, carried over when the selector is swapped. */
  last?: { value: T };
}

/** `useStore` against any store; the app's components use `useStore`. */
export function useStoreOf<S, E, T>(
  source: Store<S, E>,
  selector: (state: S) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const memo = useRef<Memo<S, T> | null>(null);
  if (!memo.current || memo.current.selector !== selector || memo.current.isEqual !== isEqual) {
    // An inline selector is a new function every render; seeding the new
    // memo with the last value keeps an equal selection the same object.
    const last = memo.current?.last;
    const inner = memoSelector(selector, isEqual, last);
    const next: Memo<S, T> = { selector, isEqual, select: inner, last };
    next.select = (state) => {
      const value = inner(state);
      next.last = { value };
      return value;
    };
    memo.current = next;
  }
  const { select } = memo.current;
  return useSyncExternalStore(
    source.subscribe,
    () => select(source.getState()),
  );
}

/** Select from the renderer's store, re-rendering only when the selection changes. */
export function useStore<T>(
  selector: (state: RendererState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useStoreOf(store, selector, isEqual);
}
