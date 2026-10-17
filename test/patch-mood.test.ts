import { test } from 'node:test';
import assert from 'node:assert';
import {
  beatFor, dropBeat, FLING_SPEED, patchBeats, patchMood, pokeBeat, RAPID_POKE_WINDOW_MS, timeOfDay,
  type PatchContext,
} from '../src/domain/companion/patch';

const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
const HOLIDAYS = [
  null, 'oud-en-nieuw', 'carnaval', 'valentijnsdag', 'pasen', 'koningsdag',
  'bevrijdingsdag', 'halloween', 'sint-maarten', 'sinterklaas', 'kerst',
] as const;

/** A context with no weather and no holiday at midday, so no aside is inserted unless a test asks for one. */
function ctx(over: Partial<PatchContext> = {}): PatchContext {
  return {
    running: 0, usagePercent: null, usageReset: null, sky: null, hour: 14, season: 'autumn', holiday: null, ...over,
  };
}

type Mood = ReturnType<typeof patchMood>;

/** The aside line Patch says second for a context. */
const asideLine = (over: Partial<PatchContext>) => patchBeats(ctx(over))[1].line;

test('timeOfDay buckets the hour at each boundary, with night wrapping midnight', () => {
  /* Given */
  const hours: [number, ReturnType<typeof timeOfDay>][] = [
    [4, 'night'], [5, 'morning'], [11, 'morning'], [12, 'day'], [17, 'day'],
    [18, 'evening'], [22, 'evening'], [23, 'night'], [0, 'night'],
  ];

  for (const [hour, bucket] of hours) {
    /* When */
    const actual = timeOfDay(hour);

    /* Then */
    assert.strictEqual(actual, bucket, `hour ${hour}`);
  }
});

test('mood follows the session count when usage is fine', () => {
  /* Given */
  const counts: [number, Mood][] = [[0, 'calm'], [1, 'happy'], [5, 'happy'], [6, 'frazzled']];

  for (const [running, mood] of counts) {
    /* When */
    const actual = patchMood(ctx({ running }));

    /* Then */
    assert.strictEqual(actual, mood, `${running} running`);
  }
});

test('mood switches at the usage thresholds', () => {
  /* Given */
  const usages: [number, Mood][] = [[79, 'happy'], [80, 'worried'], [94, 'worried'], [95, 'tired']];

  for (const [usagePercent, mood] of usages) {
    /* When */
    const actual = patchMood(ctx({ running: 3, usagePercent }));

    /* Then */
    assert.strictEqual(actual, mood, `${usagePercent}%`);
  }
});

test('usage overrides the session count', () => {
  /* When */
  const busyButWorried = patchMood(ctx({ running: 9, usagePercent: 85 }));
  const idleButTired = patchMood(ctx({ running: 0, usagePercent: 100 }));

  /* Then */
  assert.strictEqual(busyButWorried, 'worried');
  assert.strictEqual(idleButTired, 'tired');
});

test('unknown usage counts as fine for the mood', () => {
  /* When */
  const idle = patchMood(ctx({ running: 0, usagePercent: null }));
  const busy = patchMood(ctx({ running: 7, usagePercent: null }));

  /* Then */
  assert.strictEqual(idle, 'calm');
  assert.strictEqual(busy, 'frazzled');
});

test('unknown usage counts as fine for the beats', () => {
  /* When */
  const [first] = patchBeats(ctx({ running: 0 }));

  /* Then */
  assert.strictEqual(first.move, 'doze');
  assert.match(first.line, /nothing running/);
});

test('the first beat tracks the session-count bands at their boundaries', () => {
  /* Given */
  const bands: [number, string][] = [[0, 'doze'], [1, 'wave'], [2, 'wave'], [3, 'twirl'], [5, 'twirl'], [6, 'jelly']];

  for (const [running, move] of bands) {
    /* When */
    const first = patchBeats(ctx({ running }))[0];

    /* Then */
    assert.strictEqual(first.move, move, `${running} running`);
  }
});

test('the busy and frazzled bands say how many sessions there are', () => {
  /* When */
  const frazzled = patchBeats(ctx({ running: 6 }))[0];
  const busy = patchBeats(ctx({ running: 3 }))[0];

  /* Then */
  assert.strictEqual(frazzled.line, '6 lines at once! I’m sweating.');
  assert.strictEqual(busy.line, '3 sessions humming. Look at us go!');
});

test('the greeting is singular for one session and plural for two', () => {
  /* When */
  const one = patchBeats(ctx({ running: 1 }))[0];
  const two = patchBeats(ctx({ running: 2 }))[0];

  /* Then */
  assert.strictEqual(one.line, 'Hi! 1 session running smoothly.');
  assert.strictEqual(two.line, 'Hi! 2 sessions running smoothly.');
});

test('usage under the threshold leaves the session beat to open', () => {
  /* When */
  const beats = patchBeats(ctx({ running: 1, usagePercent: 79 }));

  /* Then */
  assert.strictEqual(beats[0].move, 'wave');
});

test('usage near the limit opens, with the session beats after it', () => {
  /* When */
  const close = patchBeats(ctx({ running: 1, usagePercent: 80 }));

  /* Then */
  assert.deepStrictEqual(close[0], { move: 'jelly', line: 'We’re at 80% of the limit. Easy does it.' });
  assert.deepStrictEqual(close.map((b) => b.move), ['jelly', 'peek', 'wave', 'love', 'hop']);
});

test('usage near the limit names the percentage, however many sessions run', () => {
  /* When */
  const beats = patchBeats(ctx({ running: 8, usagePercent: 94 }));

  /* Then */
  assert.strictEqual(beats[0].line, 'We’re at 94% of the limit. Easy does it.');
});

test('at the limit Patch naps until the reset time', () => {
  /* When */
  const known = patchBeats(ctx({ running: 4, usagePercent: 95, usageReset: '3pm (CEST)' }));

  /* Then */
  assert.deepStrictEqual(known[0], { move: 'doze', line: 'We’ve hit the limit. I’ll nap until 3pm (CEST).' });
  assert.deepStrictEqual(known[1], { move: 'stretch', line: 'Out of juice. Back when the limit resets.' });
});

test('at the limit Patch naps until it resets when the reset time is unknown', () => {
  /* When */
  const unknown = patchBeats(ctx({ usagePercent: 100 }));

  /* Then */
  assert.strictEqual(unknown[0].line, 'We’ve hit the limit. I’ll nap until it resets.');
});

test('a weather or time aside goes second', () => {
  /* When */
  const rainy = patchBeats(ctx({ running: 3, sky: 'rain' }));

  /* Then */
  assert.strictEqual(rainy[0].move, 'twirl', 'the board still opens');
  assert.deepStrictEqual(rainy[1], { move: 'peek', line: 'Leaves and a little rain. Hat on, let’s ship.' });
  assert.strictEqual(rainy.length, 3);
});

test('the aside follows the weather, the hour and the season', () => {
  /* Given */
  const cases: [Partial<PatchContext>, string, string?][] = [
    [{ sky: 'clear', hour: 9 }, 'Crunchy leaves out there today.'],
    [{ sky: 'clear', hour: 14, season: 'summer' }, 'Ice cream and a green build. Perfect.'],
    [{ sky: 'clear', hour: 1, season: 'summer' }, 'Late one, huh? Don’t forget to sleep.', 'no ice cream at 1am'],
    [{ sky: null, hour: 23 }, 'Late one, huh? Don’t forget to sleep.'],
    [{ sky: 'cloudy' }, 'Leaves everywhere. Cosy coding weather.'],
    [{ sky: 'snow', hour: 20, season: 'winter' }, 'Snow! Can we go outside after this one?'],
    [{ sky: null, hour: 7 }, 'Morning! Coffee first, then code.'],
  ];

  for (const [over, line, note] of cases) {
    /* When */
    const actual = asideLine(over);

    /* Then */
    assert.strictEqual(actual, line, note ?? JSON.stringify(over));
  }
});

test('the aside is also placed second while usage is close', () => {
  /* When */
  const beats = patchBeats(ctx({ usagePercent: 90, sky: 'snow', season: 'winter' }));

  /* Then */
  assert.deepStrictEqual(beats.map((b) => b.move), ['jelly', 'hop', 'peek', 'doze', 'stretch']);
});

test('rain gets a cheerful line in every season', () => {
  /* Given */
  const lines: [PatchContext['season'], string][] = [
    ['spring', 'Spring shower. Rainbow incoming!'],
    ['summer', 'Warm rain! Puddle jumping later.'],
    ['autumn', 'Leaves and a little rain. Hat on, let’s ship.'],
    ['winter', 'Winter drizzle. Staying in where it’s warm.'],
  ];

  for (const [season, line] of lines) {
    /* When */
    const actual = asideLine({ sky: 'rain', season });

    /* Then */
    assert.strictEqual(actual, line, season);
  }
});

test('the weather lines follow the season', () => {
  /* Given */
  const cases: [Partial<PatchContext>, string][] = [
    [{ season: 'spring', sky: 'clear' }, 'Tulips are up. So am I!'],
    [{ season: 'spring', sky: 'snow' }, 'Snow in April? Typisch.'],
    [{ season: 'summer', sky: 'cloudy' }, 'Warm and grey. Shades stay on.'],
    [{ season: 'autumn', sky: 'snow' }, 'First flakes on the leaves!'],
    [{ season: 'winter', sky: 'clear' }, 'Crisp out. Hot chocolate in hand.'],
    [{ season: 'winter', sky: 'cloudy' }, 'Grey and cold. Beanie on.'],
  ];

  for (const [over, line] of cases) {
    /* When */
    const actual = asideLine(over);

    /* Then */
    assert.strictEqual(actual, line, JSON.stringify(over));
  }
});

test('a holiday aside wins over the weather', () => {
  /* When */
  const kerst = patchBeats(ctx({ running: 3, sky: 'snow', season: 'winter', holiday: 'kerst' }));

  /* Then */
  assert.strictEqual(kerst[0].move, 'twirl', 'the board still opens');
  assert.strictEqual(kerst[1].line, 'Vrolijk kerstfeest! Lights are on.');
  assert.strictEqual(kerst.length, 3);
});

test('a holiday aside wins over the hour', () => {
  /* When */
  const newYear = asideLine({ hour: 23, holiday: 'oud-en-nieuw' });
  const kingsDay = asideLine({ sky: 'clear', hour: 19, holiday: 'koningsdag' });

  /* Then */
  assert.strictEqual(newYear, 'Oliebol? Gelukkig nieuwjaar!');
  assert.strictEqual(kingsDay, 'Oranje boven! Fijne Koningsdag!');
});

test('the holiday aside is dropped once the limit is hit', () => {
  /* When */
  const beats = patchBeats(ctx({ usagePercent: 95, holiday: 'sinterklaas' }));

  /* Then */
  assert.deepStrictEqual(beats.map((b) => b.move), ['doze', 'stretch']);
});

test('there is no aside when there is nothing worth saying', () => {
  /* Given */
  const quiet: Partial<PatchContext>[] = [{ sky: 'clear', hour: 19 }, { sky: null, hour: 14 }, { sky: null, hour: 20 }];

  for (const over of quiet) {
    /* When */
    const beats = patchBeats(ctx(over));

    /* Then */
    assert.strictEqual(beats.length, 2, JSON.stringify(over));
  }
});

test('the aside is dropped once the limit is hit', () => {
  /* When */
  const beats = patchBeats(ctx({ usagePercent: 95, sky: 'rain', hour: 23 }));

  /* Then */
  assert.deepStrictEqual(beats.map((b) => b.move), ['doze', 'stretch']);
});

test('patchBeats is never empty and every line is non-empty', () => {
  /* Given */
  const skies = [null, 'clear', 'cloudy', 'rain', 'snow'] as const;

  for (const running of [0, 1, 2, 3, 5, 6, 20]) {
    for (const usagePercent of [null, 0, 79, 80, 94, 95, 100]) {
      for (const sky of skies) {
        for (const season of SEASONS) {
          for (const holiday of HOLIDAYS) {
            for (let hour = 0; hour < 24; hour++) {
              /* When */
              const beats = patchBeats({ running, usagePercent, usageReset: null, sky, hour, season, holiday });

              /* Then */
              assert.ok(beats.length > 0);
              for (const b of beats) assert.ok(b.line.length > 0);
            }
          }
        }
      }
    }
  }
});

test('lines use typographic apostrophes and ellipses, never ASCII ones', () => {
  /* Given */
  const skies = [null, 'clear', 'cloudy', 'rain', 'snow'] as const;

  for (const running of [0, 1, 3, 6]) {
    for (const usagePercent of [null, 85, 99]) {
      for (const sky of skies) {
        for (const season of SEASONS) {
          for (const holiday of HOLIDAYS) {
            for (const hour of [9, 23]) {
              /* When */
              const beats = patchBeats({ running, usagePercent, usageReset: null, sky, hour, season, holiday });

              /* Then */
              for (const b of beats) {
                assert.ok(!b.line.includes("'"), b.line);
                assert.ok(!b.line.includes('...'), b.line);
              }
            }
          }
        }
      }
    }
  }
});

/** One session running: three beats to cycle through. */
const oneRunning = ctx({ running: 1 });

test('beatFor walks through the beats in order', () => {
  /* Given */
  const beats = patchBeats(oneRunning);

  /* When */
  const walked = [0, 1, 2].map((i) => beatFor(oneRunning, i));

  /* Then */
  assert.strictEqual(beats.length, 3);
  assert.deepStrictEqual(walked, beats);
});

test('beatFor wraps past the last beat', () => {
  /* Given */
  const beats = patchBeats(oneRunning);

  /* When */
  const fourth = beatFor(oneRunning, 3);
  const eighth = beatFor(oneRunning, 7);

  /* Then */
  assert.deepStrictEqual(fourth, beats[0]);
  assert.deepStrictEqual(eighth, beats[1]);
});

test('beatFor makes consecutive appearances differ', () => {
  for (let i = 0; i < 10; i++) {
    /* When */
    const now = beatFor(oneRunning, i);
    const next = beatFor(oneRunning, i + 1);

    /* Then */
    assert.notDeepStrictEqual(now, next);
  }
});

test('beatFor lands a stray negative or non-finite count on a beat', () => {
  /* Given */
  const beats = patchBeats(oneRunning);

  /* When */
  const negative = beatFor(oneRunning, -1);
  const nan = beatFor(oneRunning, Number.NaN);

  /* Then */
  assert.deepStrictEqual(negative, beats[2]);
  assert.deepStrictEqual(nan, beats[0]);
});

test('pokes cycle through the reactions', () => {
  /* When */
  const first = pokeBeat(0, 0, []);
  const second = pokeBeat(1, 0, []);

  /* Then */
  assert.deepStrictEqual(first, { move: 'jelly', line: 'Hey, that tickles!' });
  assert.strictEqual(second.line, 'Boop!');
});

test('pokes wrap around at both ends', () => {
  /* When */
  const eighth = pokeBeat(7, 0, []);
  const negative = pokeBeat(-1, 0, []);

  /* Then */
  assert.deepStrictEqual(eighth, pokeBeat(0, 0, []));
  assert.deepStrictEqual(negative, pokeBeat(6, 0, []));
});

const FOUR_POKES = [1000, 1500, 2000, 2500];

test('poking too fast makes Patch dizzy', () => {
  /* When */
  const beat = pokeBeat(4, 3000, FOUR_POKES);

  /* Then */
  assert.strictEqual(beat.line, 'Okay, I’m dizzy now.');
});

test('four pokes in the window are not too fast', () => {
  /* When */
  const beat = pokeBeat(4, 3000, FOUR_POKES.slice(1));

  /* Then */
  assert.strictEqual(beat.line, pokeBeat(4, 0, []).line, 'four in the window is fine');
});

test('slowing down ends the dizziness once the oldest poke has left the window', () => {
  /* When */
  const beat = pokeBeat(4, 1000 + RAPID_POKE_WINDOW_MS, FOUR_POKES);

  /* Then */
  assert.strictEqual(beat.line, pokeBeat(4, 0, []).line, 'the oldest poke has left the window');
});

test('a fast let-go is a fling', () => {
  /* When */
  const beat = dropBeat(0, FLING_SPEED + 0.1);

  /* Then */
  assert.strictEqual(beat.line, 'Wheee!');
});

test('a slow let-go is setting Patch down', () => {
  /* When */
  const beat = dropBeat(0, FLING_SPEED);

  /* Then */
  assert.strictEqual(beat.line, 'Boing! Right back where I belong.');
});

test('setting Patch down cycles through its lines and wraps', () => {
  /* When */
  const second = dropBeat(1, 0);
  const fourth = dropBeat(3, 5);

  /* Then */
  assert.strictEqual(second.line, 'Where was I? Oh, right here.');
  assert.deepStrictEqual(fourth, dropBeat(0, 5));
});
