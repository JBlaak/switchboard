/**
 * Which season and which Dutch holiday it is, so Patch can dress and talk for
 * the day.
 *
 * Everything reads the local date parts: Patch sits on someone’s screen, and a
 * holiday is the day it is where they are, not in UTC. The type values match
 * the ones in @jblaak/patch exactly, because the renderer passes them straight
 * through; they are declared here so the domain does not depend on the package.
 */

/** Meteorological seasons: whole months, which is how people actually feel them. */
export type PatchSeason = 'spring' | 'summer' | 'autumn' | 'winter';

export type PatchHoliday =
  | 'oud-en-nieuw' | 'carnaval' | 'valentijnsdag' | 'pasen' | 'koningsdag'
  | 'bevrijdingsdag' | 'halloween' | 'sint-maarten' | 'sinterklaas' | 'kerst';

const MS_PER_DAY = 86_400_000;

/**
 * A calendar day as a plain count of days. Built from UTC so a daylight-saving
 * switch can never make two days 23 or 25 hours apart and throw the arithmetic
 * off by one.
 */
function dayNumber(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day) / MS_PER_DAY;
}

/** Mar–May spring, Jun–Aug summer, Sep–Nov autumn, Dec–Feb winter. */
export function seasonOf(date: Date): PatchSeason {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'autumn';
  return 'winter';
}

/** Easter Sunday as [month 1–12, day], by the anonymous Gregorian (Meeus/Jones/Butcher) algorithm. */
function easterMonthDay(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/** Easter Sunday at local noon, so it is the right day whatever the time zone. */
export function easterSunday(year: number): Date {
  const [month, day] = easterMonthDay(year);
  return new Date(year, month - 1, day, 12);
}

/** 27 April, moved to the 26th when the 27th is a Sunday. */
function koningsdag(year: number): number {
  const the27th = dayNumber(year, 3, 27);
  return new Date(the27th * MS_PER_DAY).getUTCDay() === 0 ? the27th - 1 : the27th;
}

/**
 * The holiday on this day, or null.
 *
 * The windows only ever overlap where carnaval lands on 14 February. The
 * single-day holidays are checked first so Valentijnsdag still gets its day;
 * carnaval keeps the other two.
 */
export function holidayOn(date: Date): PatchHoliday | null {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const today = dayNumber(year, month, day);

  if ((month === 11 && day === 31) || (month === 0 && day === 1)) return 'oud-en-nieuw';
  if (month === 1 && day === 14) return 'valentijnsdag';
  if (today === koningsdag(year)) return 'koningsdag';
  if (month === 4 && day === 5) return 'bevrijdingsdag';
  if (month === 9 && day === 31) return 'halloween';
  if (month === 10 && day === 11) return 'sint-maarten';
  if (month === 11 && day >= 1 && day <= 5) return 'sinterklaas';
  // Not before the 21st: the shops may go Christmas in November, Patch waits until Sinterklaas is well over.
  if (month === 11 && day >= 21 && day <= 26) return 'kerst';

  const [easterMonth, easterDay] = easterMonthDay(year);
  const easter = dayNumber(year, easterMonth - 1, easterDay);
  // Sunday to Tuesday before Ash Wednesday.
  if (today >= easter - 49 && today <= easter - 47) return 'carnaval';
  // Good Friday to Easter Monday.
  if (today >= easter - 2 && today <= easter + 1) return 'pasen';
  return null;
}
