/**
 * Snoozing a session: keeping its row out of the list until a set time.
 *
 * The options are fixed moments in local time, offered only while they are
 * still ahead: after lunch (12:30), later today (15:00), this evening (18:00),
 * tomorrow morning (08:00), later this week (Wednesday morning from a Monday,
 * Thursday morning from a Tuesday) and this weekend (Friday at 18:00). A time
 * another option already offers is not offered twice, so on a Friday afternoon
 * "This evening" stands for the weekend too.
 */

export interface SnoozeOption {
  readonly label: string;
  readonly until: Date;
}

const SUNDAY = 0, MONDAY = 1, TUESDAY = 2, FRIDAY = 5;

/** `now`'s day, `days` on, at hours:minutes local time. */
function at(now: Date, days: number, hours: number, minutes = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hours, minutes);
}

/** Where the week's working morning lands: two days on from a Monday or a Tuesday, else none. */
function laterThisWeek(now: Date): Date | null {
  const day = now.getDay();
  return day === MONDAY || day === TUESDAY ? at(now, 2, 8) : null;
}

/** This week's Friday at 18:00; the week runs Monday to Sunday, so on a weekend it has passed. */
function thisWeekend(now: Date): Date | null {
  const day = now.getDay();
  return day === SUNDAY ? null : at(now, FRIDAY - day, 18);
}

/** The snooze options open at `now`, earliest first. */
export function snoozeOptions(now: Date): SnoozeOption[] {
  const candidates: { label: string; until: Date | null }[] = [
    { label: 'After lunch', until: at(now, 0, 12, 30) },
    { label: 'Later today', until: at(now, 0, 15) },
    { label: 'This evening', until: at(now, 0, 18) },
    { label: 'Tomorrow', until: at(now, 1, 8) },
    { label: 'Later this week', until: laterThisWeek(now) },
    { label: 'This weekend', until: thisWeekend(now) },
  ];
  const options: SnoozeOption[] = [];
  for (const { label, until } of candidates) {
    if (!until || until <= now) continue;
    if (options.some(o => o.until.getTime() === until.getTime())) continue;
    options.push({ label, until });
  }
  return options;
}

/** Whether a session snoozed until `snoozedUntil` (an ISO time, or nothing) is still asleep at `now`. */
export function isSnoozed(snoozedUntil: string | null | undefined, now: number): boolean {
  return !!snoozedUntil && Date.parse(snoozedUntil) > now;
}

/** The earliest of these snoozes still ahead of `now`: when the list next needs laying out. */
export function nextWake(snoozes: Iterable<string | null | undefined>, now: number): number | null {
  let next: number | null = null;
  for (const until of snoozes) {
    if (!until) continue;
    const t = Date.parse(until);
    if (t > now && (next === null || t < next)) next = t;
  }
  return next;
}
