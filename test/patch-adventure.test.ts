import {test} from 'node:test';
import assert from 'node:assert';
import {adventureAt, dayPartAt, sceneTimeFor} from '../src/domain/companion/adventure';
import type {DayPart, PatchPlace, SunTimes} from '../src/domain/companion/adventure';

/** A local time; month is 1–12 to read like the calendar. */
function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
    return new Date(year, month - 1, day, hour, minute);
}

/** Sun times on a local day, from local hours and minutes. */
function sun(year: number, month: number, day: number, rise: [number, number], set: [number, number]): SunTimes {
    return {sunrise: at(year, month, day, ...rise).getTime(), sunset: at(year, month, day, ...set).getTime()};
}

/** A clock hour inside each part when there are no sun times. */
const HOUR_OF: Record<DayPart, number> = {morning: 9, afternoon: 15, evening: 20, night: 23};

/** Every place picked for `part` over `days` days from a local date, in no particular order. */
function placesOver(
    start: Date,
    days: number,
    part: DayPart,
    season: Parameters<typeof adventureAt>[2],
    sky: Parameters<typeof adventureAt>[3],
): Set<PatchPlace> {
    const seen = new Set<PatchPlace>();
    for (let i = 0; i < days; i++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, HOUR_OF[part]);
        seen.add(adventureAt(day, null, season, sky).place);
    }
    return seen;
}

function sorted(places: Iterable<PatchPlace>): PatchPlace[] {
    return [...places].sort();
}

// ── Day parts ──

test('without sun times the day parts follow the clock', () => {
    /* Given */
    const times: [number, number, DayPart][] = [
        [0, 0, 'night'],
        [5, 59, 'night'],
        [6, 0, 'morning'],
        [11, 59, 'morning'],
        [12, 0, 'afternoon'],
        [17, 59, 'afternoon'],
        [18, 0, 'evening'],
        [21, 59, 'evening'],
        [22, 0, 'night'],
        [23, 59, 'night'],
    ];

    for (const [hour, minute, expected] of times) {
        /* When */
        const part = dayPartAt(at(2026, 11, 6, hour, minute), null);

        /* Then */
        assert.strictEqual(part, expected, `${hour}:${minute}`);
    }
});

test('with sun times the day parts follow sunrise, noon, sunset and 22:00', () => {
    /* Given */
    const november = sun(2026, 11, 6, [7, 48], [16, 52]);
    const times: [number, number, DayPart][] = [
        [3, 0, 'night'],
        [7, 47, 'night'],
        [7, 48, 'morning'],
        [11, 59, 'morning'],
        [12, 0, 'afternoon'],
        [16, 51, 'afternoon'],
        [16, 52, 'evening'],
        [21, 59, 'evening'],
        [22, 0, 'night'],
    ];

    for (const [hour, minute, expected] of times) {
        /* When */
        const part = dayPartAt(at(2026, 11, 6, hour, minute), november);

        /* Then */
        assert.strictEqual(part, expected, `${hour}:${minute}`);
    }
});

test('a sunset after 22:00 gives the evening one hour', () => {
    /* Given */
    const midsummerNorth = sun(2026, 6, 21, [3, 30], [22, 30]);
    const times: [number, number, DayPart][] = [
        [22, 29, 'afternoon'],
        [22, 30, 'evening'],
        [23, 29, 'evening'],
        [23, 30, 'night'],
    ];

    for (const [hour, minute, expected] of times) {
        /* When */
        const part = dayPartAt(at(2026, 6, 21, hour, minute), midsummerNorth);

        /* Then */
        assert.strictEqual(part, expected, `${hour}:${minute}`);
    }
});

test('a sunrise after noon starts the day in the afternoon', () => {
    /* Given */
    const polar = sun(2026, 12, 10, [12, 30], [13, 15]);
    const times: [number, number, DayPart][] = [
        [12, 29, 'night'],
        [12, 30, 'afternoon'],
        [13, 15, 'evening'],
    ];

    for (const [hour, minute, expected] of times) {
        /* When */
        const part = dayPartAt(at(2026, 12, 10, hour, minute), polar);

        /* Then */
        assert.strictEqual(part, expected, `${hour}:${minute}`);
    }
});

test("yesterday's sun times still read as today's", () => {
    /* Given */
    const yesterday = sun(2026, 11, 5, [7, 46], [16, 54]);

    /* When */
    const morning = dayPartAt(at(2026, 11, 6, 9, 0), yesterday);
    const evening = dayPartAt(at(2026, 11, 6, 17, 30), yesterday);

    /* Then */
    assert.strictEqual(morning, 'morning');
    assert.strictEqual(evening, 'evening');
});

test('each part of the day has its scene time', () => {
    /* Given */
    const parts: [DayPart, string][] = [
        ['morning', 'morning'],
        ['afternoon', 'day'],
        ['evening', 'evening'],
        ['night', 'night'],
    ];

    for (const [part, expected] of parts) {
        /* When */
        const time = sceneTimeFor(part);

        /* Then */
        assert.strictEqual(time, expected, part);
    }
});

// ── Stability ──

test('the adventure holds all through a part of the day', () => {
    /* Given */
    const early = at(2026, 11, 6, 6, 5);
    const late = at(2026, 11, 6, 11, 55);

    /* When */
    const first = adventureAt(early, null, 'autumn', 'cloudy');
    const second = adventureAt(late, null, 'autumn', 'cloudy');

    /* Then */
    assert.deepStrictEqual(second, first);
    assert.strictEqual(first.key, '2026-11-6:morning');
    assert.strictEqual(first.time, 'morning');
});

test('the adventure key moves on with the part of the day and the date', () => {
    /* Given */
    const moments = [
        at(2026, 11, 6, 9),
        at(2026, 11, 6, 15),
        at(2026, 11, 6, 20),
        at(2026, 11, 6, 23),
        at(2026, 11, 7, 9),
    ];

    /* When */
    const keys = moments.map((now) => adventureAt(now, null, 'autumn', 'cloudy').key);

    /* Then */
    assert.deepStrictEqual(keys, [
        '2026-11-6:morning',
        '2026-11-6:afternoon',
        '2026-11-6:evening',
        '2026-11-6:night',
        '2026-11-7:morning',
    ]);
});

test('the morning place changes from day to day', () => {
    /* Given */
    const start = at(2026, 10, 1, 9);

    /* When */
    const places = placesOver(start, 30, 'morning', 'autumn', 'cloudy');

    /* Then */
    assert.ok(places.size > 1, `only ${sorted(places).join(', ')}`);
});

test('the adventure uses the sun times for its part of the day', () => {
    /* Given */
    const november = sun(2026, 11, 6, [7, 48], [16, 52]);

    /* When */
    const adventure = adventureAt(at(2026, 11, 6, 17, 0), november, 'autumn', 'clear');

    /* Then */
    assert.strictEqual(adventure.part, 'evening');
    assert.strictEqual(adventure.time, 'evening');
    assert.strictEqual(adventure.key, '2026-11-6:evening');
});

// ── Places ──

test('rain sends the family to the tents, whatever the part of the day', () => {
    for (const part of ['morning', 'afternoon', 'evening', 'night'] as const) {
        /* Given */
        const start = at(2026, 7, 1, HOUR_OF[part]);

        /* When */
        const places = placesOver(start, 20, part, 'summer', 'rain');

        /* Then */
        assert.deepStrictEqual(sorted(places), ['tents'], part);
    }
});

test('snow means sledding or the canal by day, the campfire or the canal after dark', () => {
    /* Given */
    const start = at(2026, 12, 1, 9);
    const expected: [DayPart, PatchPlace[]][] = [
        ['morning', ['canal', 'sledding']],
        ['afternoon', ['canal', 'sledding']],
        ['evening', ['campfire', 'canal']],
        ['night', ['campfire', 'canal']],
    ];

    for (const [part, pool] of expected) {
        /* When */
        const places = placesOver(start, 40, part, 'winter', 'snow');

        /* Then */
        assert.deepStrictEqual(sorted(places), pool, part);
    }
});

test('a clear night may be for stargazing, a cloudy one not', () => {
    /* Given */
    const start = at(2026, 8, 1, 23);

    /* When */
    const clear = placesOver(start, 40, 'night', 'summer', 'clear');
    const cloudy = placesOver(start, 40, 'night', 'summer', 'cloudy');

    /* Then */
    assert.deepStrictEqual(sorted(clear), ['campfire', 'stargazing', 'tents']);
    assert.deepStrictEqual(sorted(cloudy), ['campfire', 'tents']);
});

test('the evening is at the campfire, the pier or the tents, with the canal in winter and the dunes in summer', () => {
    /* Given */
    const expected: [Date, Parameters<typeof adventureAt>[2], PatchPlace[]][] = [
        [at(2026, 12, 1, 20), 'winter', ['campfire', 'canal', 'pier', 'tents']],
        [at(2026, 6, 1, 20), 'summer', ['campfire', 'dunes', 'pier', 'tents']],
        [at(2026, 4, 1, 20), 'spring', ['campfire', 'pier', 'tents']],
        [at(2026, 10, 1, 20), 'autumn', ['campfire', 'pier', 'tents']],
    ];

    for (const [start, season, pool] of expected) {
        /* When */
        const places = placesOver(start, 60, 'evening', season, 'cloudy');

        /* Then */
        assert.deepStrictEqual(sorted(places), pool, season);
    }
});

test('by day each season has its own places', () => {
    /* Given */
    const expected: [Date, Parameters<typeof adventureAt>[2], PatchPlace[]][] = [
        [at(2026, 3, 1, 9), 'spring', ['allotment', 'dunes', 'forest', 'tulips']],
        [at(2026, 8, 1, 9), 'summer', ['beach', 'dunes', 'forest', 'orchard', 'pier']],
        [at(2026, 9, 1, 9), 'autumn', ['dunes', 'forest', 'orchard', 'pier']],
        [at(2026, 12, 1, 9), 'winter', ['canal', 'forest', 'sledding']],
    ];

    for (const [start, season, pool] of expected) {
        for (const part of ['morning', 'afternoon'] as const) {
            /* When */
            const places = placesOver(start, 30, part, season, 'clear');

            /* Then */
            assert.deepStrictEqual(sorted(places), pool, `${season} ${part}`);
        }
    }
});

test('the orchard waits for August', () => {
    /* Given */
    const june = at(2026, 6, 1, 9);
    const august = at(2026, 8, 1, 9);

    /* When */
    const early = placesOver(june, 61, 'morning', 'summer', 'clear');
    const late = placesOver(august, 31, 'morning', 'summer', 'clear');

    /* Then */
    assert.ok(!early.has('orchard'), `June and July: ${sorted(early).join(', ')}`);
    assert.ok(late.has('orchard'), `August: ${sorted(late).join(', ')}`);
});

test('no part of the day repeats the place of the part before it', () => {
    /* Given */
    const skies = ['clear', 'cloudy', 'snow', null] as const;
    const seasons = ['spring', 'summer', 'autumn', 'winter'] as const;
    const parts: DayPart[] = ['morning', 'afternoon', 'evening', 'night'];

    for (const season of seasons) {
        for (const sky of skies) {
            for (let i = 0; i < 60; i++) {
                /* When */
                const places = parts.map(
                    (part) => adventureAt(new Date(2026, 0, 1 + i, HOUR_OF[part]), null, season, sky).place,
                );

                /* Then */
                for (let p = 1; p < parts.length; p++) {
                    assert.notStrictEqual(places[p], places[p - 1], `${season} ${sky} day ${i} ${parts[p]}`);
                }
            }
        }
    }
});
