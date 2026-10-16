import { test } from 'node:test';
import assert from 'node:assert';
import { createStore, memoSelector, shallowEqual } from '../src/renderer/state/store';

type Event = { type: 'add'; n: number } | { type: 'noop' };
const counter = (state: { n: number }, event: Event) =>
  event.type === 'add' ? { n: state.n + event.n } : state;

test('dispatch reduces and tells each listener the event and both states', () => {
  const store = createStore(counter, { n: 0 });
  const seen: [number, number, string][] = [];
  store.subscribe((state, previous, event) => seen.push([previous.n, state.n, event.type]));

  store.dispatch({ type: 'add', n: 2 });
  assert.strictEqual(store.getState().n, 2);
  assert.deepStrictEqual(seen, [[0, 2, 'add']]);
});

test('an event that changes nothing is still delivered, with the same state on both sides', () => {
  // Some pushes are only prompts to act; their handlers subscribe like anyone.
  const store = createStore(counter, { n: 0 });
  const seen: boolean[] = [];
  store.subscribe((state, previous) => seen.push(state === previous));
  store.dispatch({ type: 'noop' });
  assert.deepStrictEqual(seen, [true]);
});

test('unsubscribing stops delivery', () => {
  const store = createStore(counter, { n: 0 });
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.dispatch({ type: 'add', n: 1 });
  off();
  store.dispatch({ type: 'add', n: 1 });
  assert.strictEqual(calls, 1);
});

test('a dispatch from a listener is reduced at once but delivered after the current round', () => {
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

  store.dispatch({ type: 'add', n: 1 });
  // Every listener sees every transition, in order — b is not handed the
  // nested state before it has seen the outer one.
  assert.deepStrictEqual(log, ['a 0→1', 'a sees 11', 'b 0→1', 'a 1→11', 'b 1→11']);
});

test('a listener that throws does not wedge the store', () => {
  const store = createStore(counter, { n: 0 });
  let calls = 0;
  const off = store.subscribe(() => { throw new Error('boom'); });
  assert.throws(() => store.dispatch({ type: 'add', n: 1 }));
  off();
  store.subscribe(() => calls++);
  store.dispatch({ type: 'add', n: 1 });
  assert.strictEqual(calls, 1);
});

test('memoSelector answers the same value for the same state without selecting again', () => {
  let calls = 0;
  const select = memoSelector((s: { n: number }) => { calls++; return { doubled: s.n * 2 }; });
  const state = { n: 1 };
  const first = select(state);
  assert.strictEqual(select(state), first);
  assert.strictEqual(calls, 1);
});

test('memoSelector keeps an equal selection the same object across states', () => {
  const select = memoSelector((s: { n: number; other: number }) => ({ n: s.n }), shallowEqual);
  const first = select({ n: 1, other: 0 });
  // A new state, a new object from the selector — but equal, so the old one.
  assert.strictEqual(select({ n: 1, other: 5 }), first);
  assert.notStrictEqual(select({ n: 2, other: 5 }), first);
});

test('memoSelector seeded with a previous value keeps it when the new selector agrees', () => {
  const value = { n: 1 };
  const select = memoSelector((s: { n: number }) => ({ n: s.n }), shallowEqual, { value });
  assert.strictEqual(select({ n: 1 }), value);
});

test('shallowEqual compares one level deep', () => {
  assert.ok(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }));
  assert.ok(shallowEqual([1, 2], [1, 2]));
  assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!shallowEqual({ a: {} }, { a: {} }));
  assert.ok(!shallowEqual({ a: 1 }, null));
});
