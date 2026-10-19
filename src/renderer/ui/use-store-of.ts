/**
 * Reading any store from a React component: `useStore`'s workings, on their
 * own so the Quick Ask pop-up can read its store without the main window's.
 */
import { useRef, useSyncExternalStore } from 'react';
import { memoSelector } from '../state/store';
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
