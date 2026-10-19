/**
 * The Quick Ask pop-up's springs (#150, G4): the motion prototype's damped
 * spring at mass 1, one per channel, run on frames a test steps by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Channels, PLAYFUL, REDUCED_FADE_MS } from '../src/renderer/quick-ask/motion';
import type { Frames } from '../src/renderer/quick-ask/motion';

/** Frames a test steps: each `tick` runs what was requested, `ms` later. */
function fakeFrames(): Frames & { tick(ms?: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  let queued = new Map<number, (now: number) => void>();
  return {
    now: () => now,
    request: (frame) => { queued.set(next, frame); return next++; },
    cancel: (id) => { queued.delete(id); },
    tick(ms = 1000 / 60) {
      now += ms;
      const due = queued;
      queued = new Map();
      for (const frame of due.values()) frame(now);
    },
    pending: () => queued.size,
  };
}

/** Run frames until nothing more is asked for, or `seconds` have gone. */
function settle(frames: ReturnType<typeof fakeFrames>, seconds = 3): number {
  let t = 0;
  while (frames.pending() > 0 && t < seconds * 1000) { frames.tick(); t += 1000 / 60; }
  return t;
}

test('the open spring overshoots, then comes to rest exactly on its target', () => {
  /* Given */
  const frames = fakeFrames();
  const channels = new Channels(frames);
  const seen: number[] = [];
  let done = false;

  /* When */
  channels.spring('open', 0, 1, PLAYFUL.open, x => seen.push(x), () => { done = true; });
  const took = settle(frames);

  /* Then */
  assert.equal(done, true);
  assert.equal(seen.at(-1), 1);
  assert.equal(channels.moving('open'), false);
  assert.ok(Math.max(...seen) > 1.05, `Playful bounces: peak ${Math.max(...seen)}`);
  assert.ok(took < 1500, `settles in ${took} ms`);
});

test('a spring cancelled mid-way stops where it is, and never says it is done', () => {
  /* Given */
  const frames = fakeFrames();
  const channels = new Channels(frames);
  const seen: number[] = [];
  let done = false;
  channels.spring('width', 62, 640, PLAYFUL.size, x => seen.push(x), () => { done = true; });
  frames.tick();
  frames.tick();
  const updates = seen.length;

  /* When */
  channels.stop('width');
  settle(frames);

  /* Then */
  assert.equal(seen.length, updates);
  assert.equal(done, false);
  assert.equal(channels.moving('width'), false);
});

test('a new spring on the same channel takes over from the old one', () => {
  /* Given */
  const frames = fakeFrames();
  const channels = new Channels(frames);
  const first: number[] = [];
  let second = 0;
  channels.spring('width', 62, 640, PLAYFUL.size, x => first.push(x));
  frames.tick();
  const firstUpdates = first.length;

  /* When */
  channels.spring('width', first.at(-1)!, 62, PLAYFUL.shrink, (x) => { second = x; });
  settle(frames);

  /* Then */
  assert.equal(first.length, firstUpdates);
  assert.equal(second, 62);
});

test('the pulse starts and ends at rest, kicked out in between', () => {
  /* Given */
  const frames = fakeFrames();
  const channels = new Channels(frames);
  const seen: number[] = [];

  /* When */
  channels.spring('pulse', 1, 1, PLAYFUL.pulse, x => seen.push(x), undefined, PLAYFUL.kick);
  settle(frames);

  /* Then */
  assert.ok(Math.max(...seen) > 1.1, `kicked to ${Math.max(...seen)}`);
  assert.equal(seen.at(-1), 1);
});

test('under Reduce motion a spring jumps to its end at once', () => {
  /* Given */
  const frames = fakeFrames();
  const channels = new Channels(frames);
  channels.mode = 'reduced';
  const seen: number[] = [];
  let done = false;

  /* When */
  channels.spring('open', 0, 1, PLAYFUL.open, x => seen.push(x), () => { done = true; });

  /* Then */
  assert.deepEqual(seen, [1]);
  assert.equal(done, true);
  assert.equal(frames.pending(), 0);
});

test('under Reduce motion every fade lasts 120 ms, evenly', () => {
  /* Given */
  const frames = fakeFrames();
  const channels = new Channels(frames);
  channels.mode = 'reduced';
  const seen: number[] = [];

  /* When */
  channels.tween('fade', PLAYFUL.closeMs, t => seen.push(t));
  frames.tick(REDUCED_FADE_MS / 2);
  frames.tick(REDUCED_FADE_MS / 2);

  /* Then */
  assert.deepEqual(seen, [0.5, 1]);
  assert.equal(channels.moving('fade'), false);
});

test('under the e2e harness a fade jumps to its end too', () => {
  /* Given */
  const frames = fakeFrames();
  const channels = new Channels(frames);
  channels.mode = 'instant';
  const seen: number[] = [];
  let done = false;

  /* When */
  channels.tween('fade', PLAYFUL.closeMs, t => seen.push(t), () => { done = true; });

  /* Then */
  assert.deepEqual(seen, [1]);
  assert.equal(done, true);
});
