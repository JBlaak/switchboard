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
import { store } from '../state/app-store';
import { useStoreOf } from './use-store-of';
import type { RendererState } from '../state/root';

/** Select from the renderer's store, re-rendering only when the selection changes. */
export function useStore<T>(
  selector: (state: RendererState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useStoreOf(store, selector, isEqual);
}
