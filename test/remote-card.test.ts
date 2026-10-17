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
  /* When */
  let state = run(initialRendererState(), status({ phase: 'connecting' }));

  /* Then */
  assert.deepStrictEqual(state.remote.cards.s1, { beat: false, barRun: 1, barMs: CONNECT_TIMEOUT_MS });

  /* When */
  state = run(state, status({ phase: 'retrying', delayMs: 4000 }));

  /* Then */
  assert.deepStrictEqual(state.remote.cards.s1, { beat: false, barRun: 2, barMs: 4000 });

  /* When */
  state = run(state, status({ phase: 'connecting', attempt: 2 }));

  /* Then */
  assert.strictEqual(state.remote.cards.s1.barRun, 3);

  // A failure ends the attempt without starting another.
  /* When */
  const failed = run(state, status({ phase: 'failed' }));

  /* Then */
  assert.strictEqual(failed.remote.cards.s1, state.remote.cards.s1);
});

test('the card is up while in flight or failed, and down once connected', () => {
  /* Given */
  const shown = (s: RendererState) => remoteCardShownIn(s.remote, 's1');

  /* When */
  const idle = shown(initialRendererState());
  const connecting = shown(run(initialRendererState(), status({ phase: 'connecting' })));
  const retrying = shown(run(initialRendererState(), status({ phase: 'retrying' })));
  const failed = shown(run(initialRendererState(), status({ phase: 'failed' })));
  // A first connect: no beat, the card goes at once.
  const connected = shown(run(initialRendererState(), status({ phase: 'connecting' }), status({ phase: 'connected' })));

  /* Then */
  assert.strictEqual(idle, false);
  assert.strictEqual(connecting, true);
  assert.strictEqual(retrying, true);
  assert.strictEqual(failed, true);
  assert.strictEqual(connected, false);
});

test('a reconnect holds a green beat until it is ended', () => {
  /* When */
  const beat = run(initialRendererState(), status({ phase: 'connecting', attempt: 2 }), status({ phase: 'connected' }));

  /* Then */
  assert.strictEqual(beat.remote.cards.s1.beat, true);
  assert.strictEqual(remoteCardShownIn(beat.remote, 's1'), true);

  /* When */
  const ended = run(beat, { type: 'remoteConnectedBeatEnded', sessionId: 's1' });

  /* Then */
  assert.strictEqual(remoteCardShownIn(ended.remote, 's1'), false);
});

test('ending a beat that is already over changes nothing', () => {
  // Ending it again, or for a card with no beat, changes nothing.
  /* Given */
  const ended = run(initialRendererState(),
    status({ phase: 'connecting', attempt: 2 }), status({ phase: 'connected' }),
    { type: 'remoteConnectedBeatEnded', sessionId: 's1' });

  /* When */
  const next = rootReducer(ended, { type: 'remoteConnectedBeatEnded', sessionId: 's1' });

  /* Then */
  assert.strictEqual(next, ended);
});

test('a new attempt during the beat cuts it short', () => {
  /* Given */
  const beat = run(initialRendererState(), status({ phase: 'connecting', attempt: 2 }), status({ phase: 'connected' }));

  /* When */
  const state = run(beat, status({ phase: 'retrying' }));

  /* Then */
  assert.strictEqual(state.remote.cards.s1.beat, false);
});

test('a disconnect takes the card', () => {
  /* Given */
  const connecting = run(initialRendererState(), status({ phase: 'connecting' }));

  /* When */
  const next = run(connecting, status({ phase: 'disconnected' }));

  /* Then */
  assert.deepStrictEqual(next.remote.cards, {});
});

test('a forgotten status takes the card', () => {
  /* Given */
  const connecting = run(initialRendererState(), status({ phase: 'connecting' }));

  /* When */
  const next = run(connecting, { type: 'remoteStatusForgotten', sessionId: 's1' });

  /* Then */
  assert.deepStrictEqual(next.remote.cards, {});
});

test('a re-key moves the card with the status', () => {
  /* Given */
  const state = run(initialRendererState(), status({ phase: 'connecting' }));

  /* When */
  const moved = rekeyState(state, 's1', 's2');

  /* Then */
  assert.deepStrictEqual(Object.keys(moved.remote.cards), ['s2']);
  assert.deepStrictEqual(Object.keys(moved.remote.statuses), ['s2']);
});

test('the countdown tick repaints the header, which drops a CLI notice', () => {
  /* Given */
  const state = run(initialRendererState(),
    { type: 'terminalOpened', sessionId: 's1', slotId: 1 },
    { type: 'sessionShown', sessionId: 's1', name: 'remote' },
    { type: 'terminalNotification', sessionId: 's1', message: 'Approve in 1Password' });

  /* When */
  const ticked = run(state, { type: 'remoteTick', at: 1 });

  /* Then */
  assert.strictEqual(state.terminal.notice, 'Approve in 1Password');
  assert.strictEqual(ticked.terminal.notice, null);
});

// ── What the card says ──

test('a connecting card counts up toward the timeout, after the first second', () => {
  /* Given */
  const s = { phase: 'connecting', attempt: 1, maxAttempts: 6, startedAt: 1000 } as const;

  /* When */
  const early = remoteCardCopy(s, 1500);
  const later = remoteCardCopy(s, 3200);
  const firstDial = remoteCardCopy({ phase: 'connecting', startedAt: 0 }, 0);

  /* Then */
  assert.deepStrictEqual(early, { status: 'Reconnecting', detail: 'attempt 1 of 6' });
  assert.deepStrictEqual(later, { status: 'Reconnecting', detail: 'attempt 1 of 6 · 2s' });
  assert.strictEqual(firstDial.status, 'Connecting');
});

test('a retrying card counts down and never below zero', () => {
  /* Given */
  const s = { phase: 'retrying', reason: 'dropped', attempt: 2, maxAttempts: 6, retryAt: 10_000 } as const;

  /* When */
  const counting = remoteCardCopy(s, 5_000);
  const overdue = remoteCardCopy(s, 12_000);

  /* Then */
  assert.deepStrictEqual(counting, { status: 'Reconnecting in 5s', detail: 'dropped · attempt 2 of 6' });
  assert.strictEqual(overdue.status, 'Reconnecting…');
});

test('a failed card says whether it ever got through', () => {
  /* When */
  const neverConnected = remoteCardCopy({ phase: 'failed', reason: 'rejected' }, 0);
  const lost = remoteCardCopy({ phase: 'failed', everConnected: true }, 0);

  /* Then */
  assert.deepStrictEqual(neverConnected, { status: 'Could not connect', detail: 'rejected' });
  assert.strictEqual(lost.status, 'Lost connection');
});

// ── The shared tick ──

test('the tick runs only while some connection is in flight', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  try {
    /* Given */
    const store = createStore(rootReducer, initialRendererState());
    const ticks: number[] = [];
    store.subscribe((_s, _p, event) => { if (event.type === 'remoteTick') ticks.push(event.at); });
    const stop = installRemoteTicker(store);

    /* When */
    mock.timers.tick(REMOTE_TICK_MS * 3);

    /* Then */
    assert.deepStrictEqual(ticks, [], 'nothing in flight, nothing ticks');

    /* When */
    store.dispatch(status({ phase: 'connecting' }));
    mock.timers.tick(REMOTE_TICK_MS * 2);

    /* Then */
    assert.strictEqual(ticks.length, 2);
    assert.strictEqual(store.getState().remote.tickAt, Date.now());

    /* When */
    store.dispatch(status({ phase: 'failed' }));
    mock.timers.tick(REMOTE_TICK_MS * 3);

    /* Then */
    assert.strictEqual(ticks.length, 2, 'a failure stops it');

    /* When */
    store.dispatch(status({ phase: 'retrying', delayMs: 5000 }));
    mock.timers.tick(REMOTE_TICK_MS);

    /* Then */
    assert.strictEqual(ticks.length, 3, 'a new backoff starts it again');

    /* When */
    stop();
    mock.timers.tick(REMOTE_TICK_MS * 3);

    /* Then */
    assert.strictEqual(ticks.length, 3);
  } finally {
    mock.timers.reset();
  }
});
