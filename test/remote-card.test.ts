import { mock, test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rekeyState, rootReducer } from '../src/renderer/state/root';
import { CONNECT_TIMEOUT_MS, remoteCardShownIn } from '../src/renderer/state/remote-slice';
import { REMOTE_TICK_MS, installRemoteTicker } from '../src/renderer/state/remote-ticker';
import { createStore } from '../src/renderer/state/store';
import { remoteCardCopy } from '../src/renderer/ui/remote/card-copy';
import type { RemoteStatusPayload } from '../src/domain/remote/remote-status';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const status = (s: RemoteStatusPayload, receivedAt = 0): RendererEvent =>
  ({ type: 'remoteStatus', sessionId: 's1', status: s, receivedAt });

// ── The card in the store ──

test('each dial and each backoff starts a new run of the bar, over its own length', () => {
  let state = run(initialRendererState(), status({ phase: 'connecting' }));
  assert.deepStrictEqual(state.remote.cards.s1, { beat: false, barRun: 1, barMs: CONNECT_TIMEOUT_MS });
  state = run(state, status({ phase: 'retrying', delayMs: 4000 }));
  assert.deepStrictEqual(state.remote.cards.s1, { beat: false, barRun: 2, barMs: 4000 });
  state = run(state, status({ phase: 'connecting', attempt: 2 }));
  assert.strictEqual(state.remote.cards.s1.barRun, 3);
  // A failure ends the attempt without starting another.
  const failed = run(state, status({ phase: 'failed' }));
  assert.strictEqual(failed.remote.cards.s1, state.remote.cards.s1);
});

test('the card is up while in flight or failed, and down once connected', () => {
  const shown = (s: RendererState) => remoteCardShownIn(s.remote, 's1');
  assert.strictEqual(shown(initialRendererState()), false);
  assert.strictEqual(shown(run(initialRendererState(), status({ phase: 'connecting' }))), true);
  assert.strictEqual(shown(run(initialRendererState(), status({ phase: 'retrying' }))), true);
  assert.strictEqual(shown(run(initialRendererState(), status({ phase: 'failed' }))), true);
  // A first connect: no beat, the card goes at once.
  assert.strictEqual(shown(run(initialRendererState(), status({ phase: 'connecting' }), status({ phase: 'connected' }))), false);
});

test('a reconnect holds a green beat until it is ended', () => {
  const beat = run(initialRendererState(), status({ phase: 'connecting', attempt: 2 }), status({ phase: 'connected' }));
  assert.strictEqual(beat.remote.cards.s1.beat, true);
  assert.strictEqual(remoteCardShownIn(beat.remote, 's1'), true);

  const ended = run(beat, { type: 'remoteConnectedBeatEnded', sessionId: 's1' });
  assert.strictEqual(remoteCardShownIn(ended.remote, 's1'), false);
  // Ending it again, or for a card with no beat, changes nothing.
  assert.strictEqual(rootReducer(ended, { type: 'remoteConnectedBeatEnded', sessionId: 's1' }), ended);
});

test('a new attempt during the beat cuts it short', () => {
  const state = run(initialRendererState(),
    status({ phase: 'connecting', attempt: 2 }), status({ phase: 'connected' }), status({ phase: 'retrying' }));
  assert.strictEqual(state.remote.cards.s1.beat, false);
});

test('a disconnect or a forgotten status takes the card too', () => {
  const connecting = run(initialRendererState(), status({ phase: 'connecting' }));
  assert.deepStrictEqual(run(connecting, status({ phase: 'disconnected' })).remote.cards, {});
  assert.deepStrictEqual(run(connecting, { type: 'remoteStatusForgotten', sessionId: 's1' }).remote.cards, {});
});

test('a re-key moves the card with the status', () => {
  const state = run(initialRendererState(), status({ phase: 'connecting' }));
  const moved = rekeyState(state, 's1', 's2');
  assert.deepStrictEqual(Object.keys(moved.remote.cards), ['s2']);
  assert.deepStrictEqual(Object.keys(moved.remote.statuses), ['s2']);
});

test('the countdown tick repaints the header, which drops a CLI notice', () => {
  const state = run(initialRendererState(),
    { type: 'terminalOpened', sessionId: 's1', slotId: 1 },
    { type: 'sessionShown', sessionId: 's1', name: 'remote' },
    { type: 'terminalNotification', sessionId: 's1', message: 'Approve in 1Password' });
  assert.strictEqual(state.terminal.notice, 'Approve in 1Password');
  assert.strictEqual(run(state, { type: 'remoteTick', at: 1 }).terminal.notice, null);
});

// ── What the card says ──

test('a connecting card counts up toward the timeout, after the first second', () => {
  const s = { phase: 'connecting', attempt: 1, maxAttempts: 6, startedAt: 1000 } as const;
  assert.deepStrictEqual(remoteCardCopy(s, 1500), { status: 'Reconnecting', detail: 'attempt 1 of 6' });
  assert.deepStrictEqual(remoteCardCopy(s, 3200), { status: 'Reconnecting', detail: 'attempt 1 of 6 · 2s' });
  assert.strictEqual(remoteCardCopy({ phase: 'connecting', startedAt: 0 }, 0).status, 'Connecting');
});

test('a retrying card counts down and never below zero', () => {
  const s = { phase: 'retrying', reason: 'dropped', attempt: 2, maxAttempts: 6, retryAt: 10_000 } as const;
  assert.deepStrictEqual(remoteCardCopy(s, 5_000), { status: 'Reconnecting in 5s', detail: 'dropped · attempt 2 of 6' });
  assert.strictEqual(remoteCardCopy(s, 12_000).status, 'Reconnecting…');
});

test('a failed card says whether it ever got through', () => {
  assert.deepStrictEqual(remoteCardCopy({ phase: 'failed', reason: 'rejected' }, 0), { status: 'Could not connect', detail: 'rejected' });
  assert.strictEqual(remoteCardCopy({ phase: 'failed', everConnected: true }, 0).status, 'Lost connection');
});

// ── The shared tick ──

test('the tick runs only while some connection is in flight', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  try {
    const store = createStore(rootReducer, initialRendererState());
    const ticks: number[] = [];
    store.subscribe((_s, _p, event) => { if (event.type === 'remoteTick') ticks.push(event.at); });
    const stop = installRemoteTicker(store);

    mock.timers.tick(REMOTE_TICK_MS * 3);
    assert.deepStrictEqual(ticks, [], 'nothing in flight, nothing ticks');

    store.dispatch(status({ phase: 'connecting' }));
    mock.timers.tick(REMOTE_TICK_MS * 2);
    assert.strictEqual(ticks.length, 2);
    assert.strictEqual(store.getState().remote.tickAt, Date.now());

    store.dispatch(status({ phase: 'failed' }));
    mock.timers.tick(REMOTE_TICK_MS * 3);
    assert.strictEqual(ticks.length, 2, 'a failure stops it');

    store.dispatch(status({ phase: 'retrying', delayMs: 5000 }));
    mock.timers.tick(REMOTE_TICK_MS);
    assert.strictEqual(ticks.length, 3, 'a new backoff starts it again');

    stop();
    mock.timers.tick(REMOTE_TICK_MS * 3);
    assert.strictEqual(ticks.length, 3);
  } finally {
    mock.timers.reset();
  }
});
