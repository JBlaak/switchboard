import { test } from 'node:test';
import assert from 'node:assert';
import { easterSunday, holidayOn, seasonOf } from '../src/domain/companion/calendar';

/** A local date; month is 1–12 to read like the calendar. */
function on(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month - 1, day, hour);
}

/** "YYYY-MM-DD" from local date parts. */
function ymd(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type Expected = ReturnType<typeof holidayOn>;

/** Each local date with the holiday it should be, and an optional note for the failure message. */
type Day = [Date, Expected, string?];

test('seasons change on the first of the month at every boundary', () => {
  /* Given */
  const days: [Date, ReturnType<typeof seasonOf>][] = [
    [on(2026, 2, 28), 'winter'],
    [on(2028, 2, 29), 'winter'],
    [on(2026, 3, 1), 'spring'],
    [on(2026, 5, 31), 'spring'],
    [on(2026, 6, 1), 'summer'],
    [on(2026, 8, 31), 'summer'],
    [on(2026, 9, 1), 'autumn'],
    [on(2026, 11, 30), 'autumn'],
    [on(2026, 12, 1), 'winter'],
    [on(2027, 1, 15), 'winter'],
  ];

  for (const [date, season] of days) {
    /* When */
    const actual = seasonOf(date);

    /* Then */
    assert.strictEqual(actual, season, ymd(date));
  }
});

test('Easter Sunday falls on the known dates', () => {
  /* Given */
  const known: [number, string][] = [
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2038, '2038-04-25'],
  ];

  for (const [year, date] of known) {
    /* When */
    const easter = ymd(easterSunday(year));

    /* Then */
    assert.strictEqual(easter, date);
  }
});

test('oud-en-nieuw is New Year’s Eve and New Year’s Day', () => {
  /* Given */
  const days: Day[] = [
    [on(2026, 12, 30), null],
    [on(2026, 12, 31), 'oud-en-nieuw'],
    [on(2027, 1, 1), 'oud-en-nieuw'],
    [on(2027, 1, 2), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('carnaval is the Sunday to Tuesday before Ash Wednesday', () => {
  /* Given */
  const days: Day[] = [
    [on(2027, 2, 6), null],
    [on(2027, 2, 7), 'carnaval'],
    [on(2027, 2, 8), 'carnaval'],
    [on(2027, 2, 9), 'carnaval'],
    [on(2027, 2, 10), null, 'Ash Wednesday'],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('carnaval follows Easter from year to year', () => {
  /* Given */
  // 2026: Easter 5 April, so carnaval runs 15–17 February.
  const days: Day[] = [
    [on(2026, 2, 14), 'valentijnsdag'],
    [on(2026, 2, 15), 'carnaval'],
    [on(2026, 2, 17), 'carnaval'],
    [on(2026, 2, 18), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('valentijnsdag is 14 February', () => {
  /* Given */
  const days: Day[] = [
    [on(2027, 2, 13), null],
    [on(2027, 2, 14), 'valentijnsdag'],
    [on(2027, 2, 15), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('valentijnsdag is 14 February, even when carnaval lands on it', () => {
  /* Given */
  // 2021: Easter 4 April, so carnaval ran 14–16 February.
  const days: Day[] = [
    [on(2021, 2, 14), 'valentijnsdag'],
    [on(2021, 2, 15), 'carnaval'],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('pasen runs from Good Friday to Easter Monday', () => {
  /* Given */
  const days: Day[] = [
    [on(2026, 4, 2), null],
    [on(2026, 4, 3), 'pasen'],
    [on(2026, 4, 5), 'pasen'],
    [on(2026, 4, 6), 'pasen'],
    [on(2026, 4, 7), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('pasen is unaffected by daylight saving starting', () => {
  /* Given */
  // 2024 straddles the end of March, where daylight saving starts.
  const days: Day[] = [
    [on(2024, 3, 28), null],
    [on(2024, 3, 29), 'pasen'],
    [on(2024, 4, 1), 'pasen'],
    [on(2024, 4, 2), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('koningsdag is 27 April', () => {
  /* Given */
  const days: Day[] = [
    [on(2026, 4, 26), null],
    [on(2026, 4, 27), 'koningsdag'],
    [on(2026, 4, 28), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('koningsdag is the 26th when the 27th is a Sunday', () => {
  /* Given */
  const days: Day[] = [
    [on(2025, 4, 25), null],
    [on(2025, 4, 26), 'koningsdag'],
    [on(2025, 4, 27), null, 'a Sunday'],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('the single-day holidays are only their day', () => {
  /* Given */
  const holidays: [number, number, Expected][] = [
    [5, 5, 'bevrijdingsdag'], [10, 31, 'halloween'], [11, 11, 'sint-maarten'],
  ];
  const days: Day[] = holidays.flatMap(([month, day, holiday]): Day[] => [
    [on(2026, month, day - 1), null],
    [on(2026, month, day), holiday],
    [on(2026, month, day + 1), null],
  ]);

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('sinterklaas is 1–5 December', () => {
  /* Given */
  const days: Day[] = [
    [on(2026, 11, 30), null],
    [on(2026, 12, 1), 'sinterklaas'],
    [on(2026, 12, 5), 'sinterklaas'],
    [on(2026, 12, 6), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('kerst is 21–26 December', () => {
  /* Given */
  const days: Day[] = [
    [on(2026, 12, 20), null],
    [on(2026, 12, 21), 'kerst'],
    [on(2026, 12, 26), 'kerst'],
    [on(2026, 12, 27), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('the local date counts, whatever the hour', () => {
  /* Given */
  const days: Day[] = [
    [on(2026, 10, 31, 0), 'halloween'],
    [on(2026, 10, 31, 23), 'halloween'],
    [on(2026, 4, 3, 0), 'pasen'],
    [on(2026, 4, 6, 23), 'pasen'],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});

test('an ordinary day is no holiday', () => {
  /* Given */
  const days: Day[] = [
    [on(2026, 10, 17), null],
    [on(2026, 7, 8), null],
  ];

  for (const [date, holiday, note] of days) {
    /* When */
    const actual = holidayOn(date);

    /* Then */
    assert.strictEqual(actual, holiday, note ?? ymd(date));
  }
});
