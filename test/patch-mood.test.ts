import { test } from 'node:test';
import assert from 'node:assert';
import {
  beatFor, patchBeats, patchMood, pokeBeat, RAPID_POKE_WINDOW_MS, timeOfDay, type PatchContext,
} from '../src/domain/companion/patch';

/** A context with no weather at midday, so no aside is inserted unless a test asks for one. */
function ctx(over: Partial<PatchContext> = {}): PatchContext {
  return { running: 0, usagePercent: null, usageReset: null, sky: null, hour: 14, ...over };
}

test('timeOfDay buckets the hour at each boundary, with night wrapping midnight', () => {
  const at = (h: number) => timeOfDay(h);
  assert.strictEqual(at(4), 'night');
  assert.strictEqual(at(5), 'morning');
  assert.strictEqual(at(11), 'morning');
  assert.strictEqual(at(12), 'day');
  assert.strictEqual(at(17), 'day');
  assert.strictEqual(at(18), 'evening');
  assert.strictEqual(at(22), 'evening');
  assert.strictEqual(at(23), 'night');
  assert.strictEqual(at(0), 'night');
});

test('mood follows the session count when usage is fine', () => {
  assert.strictEqual(patchMood(ctx({ running: 0 })), 'calm');
  assert.strictEqual(patchMood(ctx({ running: 1 })), 'happy');
  assert.strictEqual(patchMood(ctx({ running: 5 })), 'happy');
  assert.strictEqual(patchMood(ctx({ running: 6 })), 'frazzled');
});

test('mood switches at the usage thresholds and usage overrides the session count', () => {
  assert.strictEqual(patchMood(ctx({ running: 3, usagePercent: 79 })), 'happy');
  assert.strictEqual(patchMood(ctx({ running: 3, usagePercent: 80 })), 'worried');
  assert.strictEqual(patchMood(ctx({ running: 3, usagePercent: 94 })), 'worried');
  assert.strictEqual(patchMood(ctx({ running: 3, usagePercent: 95 })), 'tired');
  assert.strictEqual(patchMood(ctx({ running: 9, usagePercent: 85 })), 'worried');
  assert.strictEqual(patchMood(ctx({ running: 0, usagePercent: 100 })), 'tired');
});

test('unknown usage counts as fine', () => {
  assert.strictEqual(patchMood(ctx({ running: 0, usagePercent: null })), 'calm');
  assert.strictEqual(patchMood(ctx({ running: 7, usagePercent: null })), 'frazzled');
  assert.strictEqual(patchBeats(ctx({ running: 0 }))[0].move, 'doze');
  assert.match(patchBeats(ctx({ running: 0 }))[0].line, /nothing running/);
});

test('the first beat tracks the session-count bands at their boundaries', () => {
  const first = (running: number) => patchBeats(ctx({ running }))[0];
  assert.strictEqual(first(0).move, 'doze');
  assert.strictEqual(first(1).move, 'wave');
  assert.strictEqual(first(2).move, 'wave');
  assert.strictEqual(first(3).move, 'twirl');
  assert.strictEqual(first(5).move, 'twirl');
  assert.strictEqual(first(6).move, 'jelly');
  assert.strictEqual(first(6).line, '6 lines at once! I’m sweating.');
  assert.strictEqual(first(3).line, '3 sessions humming. Look at us go!');
});

test('the greeting is singular for one session and plural for two', () => {
  assert.strictEqual(patchBeats(ctx({ running: 1 }))[0].line, 'Hi! 1 session running smoothly.');
  assert.strictEqual(patchBeats(ctx({ running: 2 }))[0].line, 'Hi! 2 sessions running smoothly.');
});

test('usage near the limit opens, with the session beats after it', () => {
  assert.strictEqual(patchBeats(ctx({ running: 1, usagePercent: 79 }))[0].move, 'wave');
  const close = patchBeats(ctx({ running: 1, usagePercent: 80 }));
  assert.deepStrictEqual(close[0], { move: 'jelly', line: 'We’re at 80% of the limit. Easy does it.' });
  assert.deepStrictEqual(close.map((b) => b.move), ['jelly', 'peek', 'wave', 'love', 'hop']);
  assert.strictEqual(patchBeats(ctx({ running: 8, usagePercent: 94 }))[0].line,
    'We’re at 94% of the limit. Easy does it.');
});

test('at the limit Patch naps until the reset time, or until it resets when that is unknown', () => {
  const known = patchBeats(ctx({ running: 4, usagePercent: 95, usageReset: '3pm (CEST)' }));
  assert.deepStrictEqual(known[0], { move: 'doze', line: 'We’ve hit the limit. I’ll nap until 3pm (CEST).' });
  assert.deepStrictEqual(known[1], { move: 'stretch', line: 'Out of juice. Back when the limit resets.' });
  const unknown = patchBeats(ctx({ usagePercent: 100 }));
  assert.strictEqual(unknown[0].line, 'We’ve hit the limit. I’ll nap until it resets.');
});

test('a weather or time aside goes second', () => {
  const rainy = patchBeats(ctx({ running: 3, sky: 'rain' }));
  assert.strictEqual(rainy[0].move, 'twirl', 'the board still opens');
  assert.deepStrictEqual(rainy[1], { move: 'peek', line: 'Raining out there. Good day to stay in and ship.' });
  assert.strictEqual(rainy.length, 3);

  const aside = (over: Partial<PatchContext>) => patchBeats(ctx(over))[1];
  assert.strictEqual(aside({ sky: 'clear', hour: 9 }).line, 'Sunny out. Shades on.');
  assert.strictEqual(aside({ sky: 'clear', hour: 14 }).line, 'Sunny out. Shades on.');
  assert.strictEqual(aside({ sky: 'clear', hour: 1 }).line, 'Late one, huh? Don’t forget to sleep.');
  assert.strictEqual(aside({ sky: null, hour: 23 }).line, 'Late one, huh? Don’t forget to sleep.');
  assert.strictEqual(aside({ sky: 'cloudy' }).line, 'Grey skies. I’ll be your sunshine.');
  assert.strictEqual(aside({ sky: 'snow', hour: 20 }).move, 'hop');
  assert.strictEqual(aside({ sky: null, hour: 7 }).line, 'Morning! Coffee first, then code.');
});

test('the aside is also placed second while usage is close', () => {
  const beats = patchBeats(ctx({ usagePercent: 90, sky: 'snow' }));
  assert.deepStrictEqual(beats.map((b) => b.move), ['jelly', 'hop', 'peek', 'doze', 'stretch']);
});

test('there is no aside when there is nothing worth saying', () => {
  assert.strictEqual(patchBeats(ctx({ sky: 'clear', hour: 19 })).length, 2);
  assert.strictEqual(patchBeats(ctx({ sky: null, hour: 14 })).length, 2);
  assert.strictEqual(patchBeats(ctx({ sky: null, hour: 20 })).length, 2);
});

test('the aside is dropped once the limit is hit', () => {
  const beats = patchBeats(ctx({ usagePercent: 95, sky: 'rain', hour: 23 }));
  assert.deepStrictEqual(beats.map((b) => b.move), ['doze', 'stretch']);
});

test('patchBeats is never empty and every line is non-empty', () => {
  const skies = [null, 'clear', 'cloudy', 'rain', 'snow'] as const;
  for (const running of [0, 1, 2, 3, 5, 6, 20]) {
    for (const usagePercent of [null, 0, 79, 80, 94, 95, 100]) {
      for (const sky of skies) {
        for (let hour = 0; hour < 24; hour++) {
          const beats = patchBeats({ running, usagePercent, usageReset: null, sky, hour });
          assert.ok(beats.length > 0);
          for (const b of beats) assert.ok(b.line.length > 0);
        }
      }
    }
  }
});

test('lines use typographic apostrophes and ellipses, never ASCII ones', () => {
  for (const running of [0, 1, 3, 6]) {
    for (const usagePercent of [null, 85, 99]) {
      for (const sky of [null, 'clear', 'cloudy', 'rain', 'snow'] as const) {
        for (const b of patchBeats({ running, usagePercent, usageReset: null, sky, hour: 23 })) {
          assert.ok(!b.line.includes("'"), b.line);
          assert.ok(!b.line.includes('...'), b.line);
        }
      }
    }
  }
});

test('beatFor cycles through the beats so consecutive appearances differ, and wraps', () => {
  const c = ctx({ running: 1 });
  const beats = patchBeats(c);
  assert.strictEqual(beats.length, 3);
  assert.deepStrictEqual([0, 1, 2].map((i) => beatFor(c, i)), beats);
  assert.deepStrictEqual(beatFor(c, 3), beats[0]);
  assert.deepStrictEqual(beatFor(c, 7), beats[1]);
  for (let i = 0; i < 10; i++) assert.notDeepStrictEqual(beatFor(c, i), beatFor(c, i + 1));
  // A stray negative or non-finite count still lands on a beat.
  assert.deepStrictEqual(beatFor(c, -1), beats[2]);
  assert.deepStrictEqual(beatFor(c, Number.NaN), beats[0]);
});

test('pokes cycle through the reactions', () => {
  assert.deepStrictEqual(pokeBeat(0, 0, []), { move: 'jelly', line: 'Hey, that tickles!' });
  assert.strictEqual(pokeBeat(1, 0, []).line, 'Boop!');
  assert.deepStrictEqual(pokeBeat(7, 0, []), pokeBeat(0, 0, []));
  assert.deepStrictEqual(pokeBeat(-1, 0, []), pokeBeat(6, 0, []));
});

test('poking too fast makes Patch dizzy, and slowing down ends it', () => {
  const four = [1000, 1500, 2000, 2500];
  assert.strictEqual(pokeBeat(4, 3000, four).line, 'Okay, I’m dizzy now.');
  assert.strictEqual(pokeBeat(4, 3000, four.slice(1)).line, pokeBeat(4, 0, []).line, 'four in the window is fine');
  assert.strictEqual(pokeBeat(4, 1000 + RAPID_POKE_WINDOW_MS, four).line, pokeBeat(4, 0, []).line,
    'the oldest poke has left the window');
});
