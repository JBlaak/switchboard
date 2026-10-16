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

test('opening and closing terminals keeps a slot each, oldest first', () => {
  let state = run(initialRendererState(), opened('a', 1), opened('b', 2));
  assert.deepStrictEqual(state.terminal.slots, [{ slotId: 1, sessionId: 'a' }, { slotId: 2, sessionId: 'b' }]);
  state = run(state, { type: 'ptyTitleChanged', sessionId: 'a', title: 't' }, { type: 'terminalClosed', sessionId: 'a' });
  assert.deepStrictEqual(state.terminal.slots, [{ slotId: 2, sessionId: 'b' }]);
  assert.deepStrictEqual(state.terminal.titles, {});
});

test('a relaunch under the same id gets a new slot', () => {
  const state = run(initialRendererState(), opened('a', 1), { type: 'terminalClosed', sessionId: 'a' }, opened('a', 2));
  assert.deepStrictEqual(state.terminal.slots, [{ slotId: 2, sessionId: 'a' }]);
});

test('a restored active session is not on screen until shown, and clearing takes it off', () => {
  let state = run(initialRendererState('a'), opened('a', 1));
  assert.strictEqual(state.terminal.onScreen, null);
  state = run(state, shown('a', 'Fix it'));
  assert.strictEqual(state.terminal.onScreen, 'a');
  assert.strictEqual(state.terminal.headerName, 'Fix it');
  state = run(state, { type: 'activeSessionChanged', sessionId: null });
  assert.strictEqual(state.terminal.onScreen, null);
});

test('a notice replaces the title for the session on screen, until a repaint or a new title', () => {
  let state = run(initialRendererState(), opened('a', 1), shown('a'),
    { type: 'ptyTitleChanged', sessionId: 'a', title: '✳ Claude Code' });
  assert.strictEqual(headerTitleIn(state.terminal), '✳ Claude Code');

  state = run(state, { type: 'terminalNotification', sessionId: 'b', message: 'elsewhere' });
  assert.strictEqual(headerTitleIn(state.terminal), '✳ Claude Code');

  state = run(state, { type: 'terminalNotification', sessionId: 'a', message: 'needs you' });
  assert.strictEqual(headerTitleIn(state.terminal), 'needs you');
  assert.strictEqual(headerTitleIn(run(state, { type: 'headerRefreshed' }).terminal), '✳ Claude Code');
  assert.strictEqual(headerTitleIn(run(state, { type: 'ptyTitleChanged', sessionId: 'a', title: 'new' }).terminal), 'new');
  // Another session's title leaves it.
  assert.strictEqual(headerTitleIn(run(state, { type: 'ptyTitleChanged', sessionId: 'b', title: 'x' }).terminal), 'needs you');
});

test('a shell lookup only lands for the session still on screen', () => {
  let state = run(initialRendererState(), shown('a'), shown('b'),
    { type: 'shellProfileResolved', sessionId: 'b', name: 'Bash' },
    { type: 'shellProfileResolved', sessionId: 'a', name: 'Fish' });
  assert.strictEqual(headerShellIn(state.terminal), 'Bash');
  state = run(state, shown('a'));
  assert.strictEqual(headerShellIn(state.terminal), null);
});

test('the search bar counts each ask, and closes', () => {
  let state = run(initialRendererState(), opened('a', 1),
    { type: 'terminalSearchOpened', sessionId: 'a' }, { type: 'terminalSearchOpened', sessionId: 'a' });
  assert.strictEqual(state.terminal.searches.a, 2);
  state = run(state, { type: 'terminalSearchClosed', sessionId: 'a' });
  assert.strictEqual(state.terminal.searches.a, undefined);
});

test('a re-key keeps the slot, the title, the search bar and the place on screen', () => {
  const before = run(initialRendererState(), opened('a', 1), shown('a'),
    { type: 'ptyTitleChanged', sessionId: 'a', title: 't' },
    { type: 'terminalSearchOpened', sessionId: 'a' },
    { type: 'shellProfileResolved', sessionId: 'a', name: 'Bash' });
  const after = run(before, { type: 'sessionForked', oldId: 'a', newId: 'b' });
  assert.deepStrictEqual(after.terminal.slots, [{ slotId: 1, sessionId: 'b' }]);
  assert.strictEqual(after.terminal.onScreen, 'b');
  assert.deepStrictEqual(after.terminal.titles, { b: 't' });
  assert.deepStrictEqual(after.terminal.searches, { b: 1 });
  assert.strictEqual(headerShellIn(after.terminal), 'Bash');
});

test('renaming the header only applies to the session on screen', () => {
  const state = run(initialRendererState(), shown('a', 'old'));
  assert.strictEqual(run(state, { type: 'headerRenamed', sessionId: 'b', name: 'x' }).terminal.headerName, 'old');
  assert.strictEqual(run(state, { type: 'headerRenamed', sessionId: 'a', name: 'new' }).terminal.headerName, 'new');
});
