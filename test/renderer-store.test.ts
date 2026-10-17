import { test } from 'node:test';
import assert from 'node:assert';
import { createStore, memoSelector, shallowEqual } from '../src/renderer/state/store';

type Event = { type: 'add'; n: number } | { type: 'noop' };
const counter = (state: { n: number }, event: Event) =>
  event.type === 'add' ? { n: state.n + event.n } : state;

test('dispatch reduces the event into the state', () => {
  /* Given */
  const store = createStore(counter, { n: 0 });

  /* When */
  store.dispatch({ type: 'add', n: 2 });

  /* Then */
  assert.strictEqual(store.getState().n, 2);
});

test('dispatch tells each listener the event and both states', () => {
  /* Given */
  const store = createStore(counter, { n: 0 });
  const seen: [number, number, string][] = [];
  store.subscribe((state, previous, event) => seen.push([previous.n, state.n, event.type]));

  /* When */
  store.dispatch({ type: 'add', n: 2 });

  /* Then */
  assert.deepStrictEqual(seen, [[0, 2, 'add']]);
});

test('an event that changes nothing is still delivered, with the same state on both sides', () => {
  // Some pushes are only prompts to act; their handlers subscribe like anyone.
  /* Given */
  const store = createStore(counter, { n: 0 });
  const seen: boolean[] = [];
  store.subscribe((state, previous) => seen.push(state === previous));

  /* When */
  store.dispatch({ type: 'noop' });

  /* Then */
  assert.deepStrictEqual(seen, [true]);
});

test('unsubscribing stops delivery', () => {
  /* Given */
  const store = createStore(counter, { n: 0 });
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.dispatch({ type: 'add', n: 1 });

  /* When */
  off();
  store.dispatch({ type: 'add', n: 1 });

  /* Then */
  assert.strictEqual(calls, 1);
});

test('a dispatch from a listener is reduced at once but delivered after the current round', () => {
  /* Given */
  const store = createStore(counter, { n: 0 });
  const log: string[] = [];
  store.subscribe((state, previous) => {
    log.push(`a ${previous.n}→${state.n}`);
    if (state.n === 1) {
      store.dispatch({ type: 'add', n: 10 });
      // Reduced immediately: getState is never behind.
      log.push(`a sees ${store.getState().n}`);
    }
  });
  store.subscribe((state, previous) => log.push(`b ${previous.n}→${state.n}`));

  /* When */
  store.dispatch({ type: 'add', n: 1 });

  /* Then */
  // Every listener sees every transition, in order — b is not handed the
  // nested state before it has seen the outer one.
  assert.deepStrictEqual(log, ['a 0→1', 'a sees 11', 'b 0→1', 'a 1→11', 'b 1→11']);
});

test('a listener that throws surfaces the error from dispatch', () => {
  /* Given */
  const store = createStore(counter, { n: 0 });
  store.subscribe(() => { throw new Error('boom'); });

  /* When */
  const act = () => store.dispatch({ type: 'add', n: 1 });

  /* Then */
  assert.throws(act);
});

test('a listener that throws does not wedge the store', () => {
  /* Given */
  const store = createStore(counter, { n: 0 });
  let calls = 0;
  const off = store.subscribe(() => { throw new Error('boom'); });
  try { store.dispatch({ type: 'add', n: 1 }); } catch { /* the throwing listener's error */ }
  off();
  store.subscribe(() => calls++);

  /* When */
  store.dispatch({ type: 'add', n: 1 });

  /* Then */
  assert.strictEqual(calls, 1);
});

test('memoSelector answers the same value for the same state without selecting again', () => {
  /* Given */
  let calls = 0;
  const select = memoSelector((s: { n: number }) => { calls++; return { doubled: s.n * 2 }; });
  const state = { n: 1 };
  const first = select(state);

  /* When */
  const second = select(state);

  /* Then */
  assert.strictEqual(second, first);
  assert.strictEqual(calls, 1);
});

test('memoSelector keeps an equal selection the same object across states', () => {
  /* Given */
  const select = memoSelector((s: { n: number; other: number }) => ({ n: s.n }), shallowEqual);
  const first = select({ n: 1, other: 0 });

  /* When */
  // A new state, a new object from the selector — but equal, so the old one.
  const equal = select({ n: 1, other: 5 });

  /* Then */
  assert.strictEqual(equal, first);
});

test('memoSelector answers a new object once the selection changes', () => {
  /* Given */
  const select = memoSelector((s: { n: number; other: number }) => ({ n: s.n }), shallowEqual);
  const first = select({ n: 1, other: 0 });
  select({ n: 1, other: 5 });

  /* When */
  const changed = select({ n: 2, other: 5 });

  /* Then */
  assert.notStrictEqual(changed, first);
});

test('memoSelector seeded with a previous value keeps it when the new selector agrees', () => {
  /* Given */
  const value = { n: 1 };
  const select = memoSelector((s: { n: number }) => ({ n: s.n }), shallowEqual, { value });

  /* When */
  const selected = select({ n: 1 });

  /* Then */
  assert.strictEqual(selected, value);
});

test('shallowEqual treats equal top-level fields as equal', () => {
  /* When */
  const objects = shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' });
  const arrays = shallowEqual([1, 2], [1, 2]);

  /* Then */
  assert.ok(objects);
  assert.ok(arrays);
});

test('shallowEqual compares only one level deep', () => {
  /* When */
  const extraKey = shallowEqual({ a: 1 }, { a: 1, b: 2 });
  const nested = shallowEqual({ a: {} }, { a: {} });
  const againstNull = shallowEqual({ a: 1 }, null);

  /* Then */
  assert.ok(!extraKey);
  assert.ok(!nested);
  assert.ok(!againstNull);
});
