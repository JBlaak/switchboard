import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { headerShellIn, headerTitleIn } from '../src/renderer/state/terminal-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const opened = (sessionId: string, slotId: number): RendererEvent => ({ type: 'terminalOpened', sessionId, slotId });
const shown = (sessionId: string, name = 'name'): RendererEvent => ({ type: 'sessionShown', sessionId, name });

test('opening terminals keeps a slot each, oldest first', () => {
  /* When */
  const state = run(initialRendererState(), opened('a', 1), opened('b', 2));

  /* Then */
  assert.deepStrictEqual(state.terminal.slots, [{ slotId: 1, sessionId: 'a' }, { slotId: 2, sessionId: 'b' }]);
});

test('closing a terminal drops its slot and its title', () => {
  /* Given */
  const state = run(initialRendererState(), opened('a', 1), opened('b', 2),
    { type: 'ptyTitleChanged', sessionId: 'a', title: 't' });

  /* When */
  const next = run(state, { type: 'terminalClosed', sessionId: 'a' });

  /* Then */
  assert.deepStrictEqual(next.terminal.slots, [{ slotId: 2, sessionId: 'b' }]);
  assert.deepStrictEqual(next.terminal.titles, {});
});

test('a relaunch under the same id gets a new slot', () => {
  /* Given */
  const state = run(initialRendererState(), opened('a', 1), { type: 'terminalClosed', sessionId: 'a' });

  /* When */
  const next = run(state, opened('a', 2));

  /* Then */
  assert.deepStrictEqual(next.terminal.slots, [{ slotId: 2, sessionId: 'a' }]);
});

test('a restored active session is not on screen until shown, and clearing takes it off', () => {
  /* When */
  let state = run(initialRendererState('a'), opened('a', 1));

  /* Then */
  assert.strictEqual(state.terminal.onScreen, null);

  /* When */
  state = run(state, shown('a', 'Fix it'));

  /* Then */
  assert.strictEqual(state.terminal.onScreen, 'a');
  assert.strictEqual(state.terminal.headerName, 'Fix it');

  /* When */
  state = run(state, { type: 'activeSessionChanged', sessionId: null });

  /* Then */
  assert.strictEqual(state.terminal.onScreen, null);
});

const titled = () => run(initialRendererState(), opened('a', 1), shown('a'),
  { type: 'ptyTitleChanged', sessionId: 'a', title: '✳ Claude Code' });
const noticed = () => run(titled(),
  { type: 'terminalNotification', sessionId: 'b', message: 'elsewhere' },
  { type: 'terminalNotification', sessionId: 'a', message: 'needs you' });

test('the header shows the title of the session on screen', () => {
  /* When */
  const state = titled();

  /* Then */
  assert.strictEqual(headerTitleIn(state.terminal), '✳ Claude Code');
});

test('a notice for another session leaves the title on screen alone', () => {
  /* Given */
  const state = titled();

  /* When */
  const next = run(state, { type: 'terminalNotification', sessionId: 'b', message: 'elsewhere' });

  /* Then */
  assert.strictEqual(headerTitleIn(next.terminal), '✳ Claude Code');
});

test('a notice replaces the title for the session on screen', () => {
  /* Given */
  const state = titled();

  /* When */
  const next = run(state, { type: 'terminalNotification', sessionId: 'a', message: 'needs you' });

  /* Then */
  assert.strictEqual(headerTitleIn(next.terminal), 'needs you');
});

test('a repaint brings the title back over a notice', () => {
  /* Given */
  const state = noticed();

  /* When */
  const next = run(state, { type: 'headerRefreshed' });

  /* Then */
  assert.strictEqual(headerTitleIn(next.terminal), '✳ Claude Code');
});

test('a new title for the session on screen replaces a notice', () => {
  /* Given */
  const state = noticed();

  /* When */
  const next = run(state, { type: 'ptyTitleChanged', sessionId: 'a', title: 'new' });

  /* Then */
  assert.strictEqual(headerTitleIn(next.terminal), 'new');
});

test('another session\'s title leaves a notice in place', () => {
  /* Given */
  const state = noticed();

  /* When */
  const next = run(state, { type: 'ptyTitleChanged', sessionId: 'b', title: 'x' });

  /* Then */
  assert.strictEqual(headerTitleIn(next.terminal), 'needs you');
});

test('a shell lookup only lands for the session still on screen', () => {
  /* When */
  let state = run(initialRendererState(), shown('a'), shown('b'),
    { type: 'shellProfileResolved', sessionId: 'b', name: 'Bash' },
    { type: 'shellProfileResolved', sessionId: 'a', name: 'Fish' });

  /* Then */
  assert.strictEqual(headerShellIn(state.terminal), 'Bash');

  /* When */
  state = run(state, shown('a'));

  /* Then */
  assert.strictEqual(headerShellIn(state.terminal), null);
});

test('the search bar counts each ask', () => {
  /* Given */
  const state = run(initialRendererState(), opened('a', 1));

  /* When */
  const next = run(state,
    { type: 'terminalSearchOpened', sessionId: 'a' }, { type: 'terminalSearchOpened', sessionId: 'a' });

  /* Then */
  assert.strictEqual(next.terminal.searches.a, 2);
});

test('the search bar closes', () => {
  /* Given */
  const state = run(initialRendererState(), opened('a', 1),
    { type: 'terminalSearchOpened', sessionId: 'a' }, { type: 'terminalSearchOpened', sessionId: 'a' });

  /* When */
  const next = run(state, { type: 'terminalSearchClosed', sessionId: 'a' });

  /* Then */
  assert.strictEqual(next.terminal.searches.a, undefined);
});

test('a re-key keeps the slot, the title, the search bar and the place on screen', () => {
  /* Given */
  const before = run(initialRendererState(), opened('a', 1), shown('a'),
    { type: 'ptyTitleChanged', sessionId: 'a', title: 't' },
    { type: 'terminalSearchOpened', sessionId: 'a' },
    { type: 'shellProfileResolved', sessionId: 'a', name: 'Bash' });

  /* When */
  const after = run(before, { type: 'sessionForked', oldId: 'a', newId: 'b' });

  /* Then */
  assert.deepStrictEqual(after.terminal.slots, [{ slotId: 1, sessionId: 'b' }]);
  assert.strictEqual(after.terminal.onScreen, 'b');
  assert.deepStrictEqual(after.terminal.titles, { b: 't' });
  assert.deepStrictEqual(after.terminal.searches, { b: 1 });
  assert.strictEqual(headerShellIn(after.terminal), 'Bash');
});

test('renaming the header for another session leaves it alone', () => {
  /* Given */
  const state = run(initialRendererState(), shown('a', 'old'));

  /* When */
  const next = run(state, { type: 'headerRenamed', sessionId: 'b', name: 'x' });

  /* Then */
  assert.strictEqual(next.terminal.headerName, 'old');
});

test('renaming the header applies to the session on screen', () => {
  /* Given */
  const state = run(initialRendererState(), shown('a', 'old'));

  /* When */
  const next = run(state, { type: 'headerRenamed', sessionId: 'a', name: 'new' });

  /* Then */
  assert.strictEqual(next.terminal.headerName, 'new');
});
