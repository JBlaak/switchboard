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

test('seasons change on the first of the month at every boundary', () => {
  assert.strictEqual(seasonOf(on(2026, 2, 28)), 'winter');
  assert.strictEqual(seasonOf(on(2028, 2, 29)), 'winter');
  assert.strictEqual(seasonOf(on(2026, 3, 1)), 'spring');
  assert.strictEqual(seasonOf(on(2026, 5, 31)), 'spring');
  assert.strictEqual(seasonOf(on(2026, 6, 1)), 'summer');
  assert.strictEqual(seasonOf(on(2026, 8, 31)), 'summer');
  assert.strictEqual(seasonOf(on(2026, 9, 1)), 'autumn');
  assert.strictEqual(seasonOf(on(2026, 11, 30)), 'autumn');
  assert.strictEqual(seasonOf(on(2026, 12, 1)), 'winter');
  assert.strictEqual(seasonOf(on(2027, 1, 15)), 'winter');
});

test('Easter Sunday falls on the known dates', () => {
  assert.strictEqual(ymd(easterSunday(2024)), '2024-03-31');
  assert.strictEqual(ymd(easterSunday(2025)), '2025-04-20');
  assert.strictEqual(ymd(easterSunday(2026)), '2026-04-05');
  assert.strictEqual(ymd(easterSunday(2027)), '2027-03-28');
  assert.strictEqual(ymd(easterSunday(2038)), '2038-04-25');
});

test('oud-en-nieuw is New Year’s Eve and New Year’s Day', () => {
  assert.strictEqual(holidayOn(on(2026, 12, 30)), null);
  assert.strictEqual(holidayOn(on(2026, 12, 31)), 'oud-en-nieuw');
  assert.strictEqual(holidayOn(on(2027, 1, 1)), 'oud-en-nieuw');
  assert.strictEqual(holidayOn(on(2027, 1, 2)), null);
});

test('carnaval is the Sunday to Tuesday before Ash Wednesday', () => {
  assert.strictEqual(holidayOn(on(2027, 2, 6)), null);
  assert.strictEqual(holidayOn(on(2027, 2, 7)), 'carnaval');
  assert.strictEqual(holidayOn(on(2027, 2, 8)), 'carnaval');
  assert.strictEqual(holidayOn(on(2027, 2, 9)), 'carnaval');
  assert.strictEqual(holidayOn(on(2027, 2, 10)), null, 'Ash Wednesday');
  // 2026: Easter 5 April, so carnaval runs 15–17 February.
  assert.strictEqual(holidayOn(on(2026, 2, 14)), 'valentijnsdag');
  assert.strictEqual(holidayOn(on(2026, 2, 15)), 'carnaval');
  assert.strictEqual(holidayOn(on(2026, 2, 17)), 'carnaval');
  assert.strictEqual(holidayOn(on(2026, 2, 18)), null);
});

test('valentijnsdag is 14 February, even when carnaval lands on it', () => {
  assert.strictEqual(holidayOn(on(2027, 2, 13)), null);
  assert.strictEqual(holidayOn(on(2027, 2, 14)), 'valentijnsdag');
  assert.strictEqual(holidayOn(on(2027, 2, 15)), null);
  // 2021: Easter 4 April, so carnaval ran 14–16 February.
  assert.strictEqual(holidayOn(on(2021, 2, 14)), 'valentijnsdag');
  assert.strictEqual(holidayOn(on(2021, 2, 15)), 'carnaval');
});

test('pasen runs from Good Friday to Easter Monday', () => {
  assert.strictEqual(holidayOn(on(2026, 4, 2)), null);
  assert.strictEqual(holidayOn(on(2026, 4, 3)), 'pasen');
  assert.strictEqual(holidayOn(on(2026, 4, 5)), 'pasen');
  assert.strictEqual(holidayOn(on(2026, 4, 6)), 'pasen');
  assert.strictEqual(holidayOn(on(2026, 4, 7)), null);
  // 2024 straddles the end of March, where daylight saving starts.
  assert.strictEqual(holidayOn(on(2024, 3, 28)), null);
  assert.strictEqual(holidayOn(on(2024, 3, 29)), 'pasen');
  assert.strictEqual(holidayOn(on(2024, 4, 1)), 'pasen');
  assert.strictEqual(holidayOn(on(2024, 4, 2)), null);
});

test('koningsdag is 27 April, or the 26th when the 27th is a Sunday', () => {
  assert.strictEqual(holidayOn(on(2026, 4, 26)), null);
  assert.strictEqual(holidayOn(on(2026, 4, 27)), 'koningsdag');
  assert.strictEqual(holidayOn(on(2026, 4, 28)), null);
  assert.strictEqual(holidayOn(on(2025, 4, 25)), null);
  assert.strictEqual(holidayOn(on(2025, 4, 26)), 'koningsdag');
  assert.strictEqual(holidayOn(on(2025, 4, 27)), null, 'a Sunday');
});

test('the single-day holidays are only their day', () => {
  const days: [number, number, string][] = [
    [5, 5, 'bevrijdingsdag'], [10, 31, 'halloween'], [11, 11, 'sint-maarten'],
  ];
  for (const [month, day, holiday] of days) {
    assert.strictEqual(holidayOn(on(2026, month, day - 1)), null);
    assert.strictEqual(holidayOn(on(2026, month, day)), holiday);
    assert.strictEqual(holidayOn(on(2026, month, day + 1)), null);
  }
});

test('sinterklaas is 1–5 December and kerst 21–26 December', () => {
  assert.strictEqual(holidayOn(on(2026, 11, 30)), null);
  assert.strictEqual(holidayOn(on(2026, 12, 1)), 'sinterklaas');
  assert.strictEqual(holidayOn(on(2026, 12, 5)), 'sinterklaas');
  assert.strictEqual(holidayOn(on(2026, 12, 6)), null);
  assert.strictEqual(holidayOn(on(2026, 12, 20)), null);
  assert.strictEqual(holidayOn(on(2026, 12, 21)), 'kerst');
  assert.strictEqual(holidayOn(on(2026, 12, 26)), 'kerst');
  assert.strictEqual(holidayOn(on(2026, 12, 27)), null);
});

test('the local date counts, whatever the hour', () => {
  assert.strictEqual(holidayOn(on(2026, 10, 31, 0)), 'halloween');
  assert.strictEqual(holidayOn(on(2026, 10, 31, 23)), 'halloween');
  assert.strictEqual(holidayOn(on(2026, 4, 3, 0)), 'pasen');
  assert.strictEqual(holidayOn(on(2026, 4, 6, 23)), 'pasen');
});

test('an ordinary day is no holiday', () => {
  assert.strictEqual(holidayOn(on(2026, 10, 17)), null);
  assert.strictEqual(holidayOn(on(2026, 7, 8)), null);
});
