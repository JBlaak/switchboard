/**
 * What Patch, the mascot on the empty screen, says and does when it comes into
 * view.
 *
 * Patch is there to make an empty board feel less empty, but it only earns its
 * place if what it says is true: a cheerful wave while the usage limit is about
 * to cut every session off would be worse than silence. So the rules rank what
 * matters — the limit first, then how busy the board is, then the weather and
 * the hour — and the renderer only picks which of the ranked beats to play.
 */

/** An animation the renderer knows how to play. */
export type PatchMove = 'wave' | 'hop' | 'twirl' | 'peek' | 'doze' | 'jelly' | 'love' | 'stretch';

/** Patch's resting expression between beats. */
export type PatchMood = 'calm' | 'happy' | 'worried' | 'frazzled' | 'tired';

/** Coarse weather, as far as Patch cares about it. */
export type PatchSky = 'clear' | 'cloudy' | 'rain' | 'snow';

export type PatchTime = 'morning' | 'day' | 'evening' | 'night';

/** Everything Patch reacts to, gathered by the renderer. */
export interface PatchContext {
  /** Sessions with a live PTY. */
  running: number;
  /** The highest usage-limit window, 0–100; null when unknown. */
  usagePercent: number | null;
  /** The human reset time of that window, e.g. "3pm (CEST)"; null when unknown. */
  usageReset: string | null;
  /** null when the weather is unknown or turned off. */
  sky: PatchSky | null;
  /** Local hour, 0–23. */
  hour: number;
}

/** One appearance: a move and the line said with it. */
export interface PatchBeat {
  move: PatchMove;
  line: string;
}

/** At or above this the limit is effectively hit and nothing else matters. */
const LIMIT_HIT = 95;
/** At or above this the limit is close enough to mention before anything else. */
const LIMIT_CLOSE = 80;
/** More sessions than this at once reads as a juggling act, not a good day. */
const BUSY_MAX = 5;

/**
 * Buckets the local hour. Night wraps midnight (23–4) so a late session and an
 * early-hours one get the same nudge to sleep.
 */
export function timeOfDay(hour: number): PatchTime {
  if (hour >= 5 && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 17) return 'day';
  if (hour >= 18 && hour <= 22) return 'evening';
  return 'night';
}

/**
 * Unknown usage counts as fine: the usage endpoint fails or rate-limits often
 * enough that treating a gap as bad news would leave Patch fretting for no
 * reason.
 */
function usageOf(ctx: PatchContext): number {
  return ctx.usagePercent ?? 0;
}

/** The limit outranks the session count, since it decides whether any session can keep going. */
export function patchMood(ctx: PatchContext): PatchMood {
  const usage = usageOf(ctx);
  if (usage >= LIMIT_HIT) return 'tired';
  if (usage >= LIMIT_CLOSE) return 'worried';
  if (ctx.running > BUSY_MAX) return 'frazzled';
  if (ctx.running >= 1) return 'happy';
  return 'calm';
}

/**
 * The beats about the board itself: the limit first when it is close, then how
 * busy it is.
 *
 * Once the limit is hit the session count drops out: nothing can make progress,
 * so cheering on the running sessions would contradict the nap.
 */
function situationBeats(ctx: PatchContext): PatchBeat[] {
  const usage = usageOf(ctx);
  if (usage >= LIMIT_HIT) {
    const until = ctx.usageReset ?? 'it resets';
    return [
      { move: 'doze', line: `We’ve hit the limit. I’ll nap until ${until}.` },
      { move: 'stretch', line: 'Out of juice. Back when the limit resets.' },
    ];
  }
  if (usage >= LIMIT_CLOSE) {
    return [
      { move: 'jelly', line: `We’re at ${Math.round(usage)}% of the limit. Easy does it.` },
      { move: 'peek', line: 'Getting close to the limit… maybe wrap one up?' },
      ...boardBeats(ctx),
    ];
  }
  return boardBeats(ctx);
}

/** How busy the board is. */
function boardBeats(ctx: PatchContext): PatchBeat[] {
  const n = Math.max(0, ctx.running);
  if (n === 0) {
    return [
      { move: 'doze', line: 'Zzz… nothing running. Wake me when you start something.' },
      { move: 'stretch', line: 'All quiet on the board. Start a session?' },
    ];
  }
  if (n <= 2) {
    return [
      { move: 'wave', line: `Hi! ${n} ${n === 1 ? 'session' : 'sessions'} running smoothly.` },
      { move: 'love', line: 'Missed you.' },
      { move: 'hop', line: 'Boing! Line’s open.' },
    ];
  }
  if (n <= BUSY_MAX) {
    return [
      { move: 'twirl', line: `${n} sessions humming. Look at us go!` },
      { move: 'hop', line: 'Busy board today!' },
    ];
  }
  return [
    { move: 'jelly', line: `${n} lines at once! I’m sweating.` },
    { move: 'peek', line: `${n} sessions… which one was yours again?` },
  ];
}

/**
 * At most one aside about the weather or the hour. The sky wins over the clock
 * when it is known; the clock alone only speaks at the ends of the day, where
 * there is something worth saying.
 */
function ambientBeat(ctx: PatchContext): PatchBeat | null {
  const time = timeOfDay(ctx.hour);
  switch (ctx.sky) {
    case 'clear':
      if (time === 'morning' || time === 'day') return { move: 'twirl', line: 'Sunny out. Shades on.' };
      if (time === 'night') return { move: 'doze', line: 'Late one, huh? Don’t forget to sleep.' };
      return null;
    case 'cloudy':
      return { move: 'stretch', line: 'Grey skies. I’ll be your sunshine.' };
    case 'rain':
      return { move: 'peek', line: 'Raining out there. Good day to stay in and ship.' };
    case 'snow':
      return { move: 'hop', line: 'Snow! Can we go outside after this one?' };
    case null:
      if (time === 'night') return { move: 'doze', line: 'Late one, huh? Don’t forget to sleep.' };
      if (time === 'morning') return { move: 'wave', line: 'Morning! Coffee first, then code.' };
      return null;
  }
}

/**
 * Everything Patch could say right now, most pressing first; never empty.
 *
 * The aside goes second rather than first so the opening beat is always about
 * the board, and it is dropped entirely once the limit is hit — small talk about
 * the weather while every session is stalled would read as not paying attention.
 */
export function patchBeats(ctx: PatchContext): PatchBeat[] {
  const beats = situationBeats(ctx);
  if (usageOf(ctx) >= LIMIT_HIT) return beats;
  const aside = ambientBeat(ctx);
  if (aside) beats.splice(1, 0, aside);
  return beats;
}

/** The beat for the nth appearance: cycles through patchBeats so consecutive appearances differ. */
export function beatFor(ctx: PatchContext, appearance: number): PatchBeat {
  const beats = patchBeats(ctx);
  const n = beats.length;
  // Negative or non-integer counts still land on a beat rather than undefined.
  const k = Number.isFinite(appearance) ? Math.trunc(appearance) : 0;
  const i = ((k % n) + n) % n;
  return beats[i];
}

/** How many pokes inside `RAPID_POKE_WINDOW_MS` count as being poked too much. */
export const RAPID_POKES = 5;
export const RAPID_POKE_WINDOW_MS = 4000;

const POKE_BEATS: readonly PatchBeat[] = [
  { move: 'jelly', line: 'Hey, that tickles!' },
  { move: 'hop', line: 'Boop!' },
  { move: 'twirl', line: 'Wheee! Again?' },
  { move: 'love', line: 'Aww, hi to you too.' },
  { move: 'stretch', line: 'Okay, okay, I’m awake!' },
  { move: 'jelly', line: 'Careful, I’m mostly jelly.' },
  { move: 'peek', line: 'Need something? The sidebar’s right there.' },
];

/**
 * What Patch does when poked: the nth reaction in turn, or a protest when the
 * pokes come too fast.
 *
 * `recentPokes` holds the times of earlier pokes, oldest first; only the ones
 * inside the window count, so a protest ends on its own once the clicking
 * slows down.
 */
export function pokeBeat(poke: number, now: number, recentPokes: readonly number[]): PatchBeat {
  const inWindow = recentPokes.filter(t => now - t < RAPID_POKE_WINDOW_MS).length;
  if (inWindow + 1 >= RAPID_POKES) return { move: 'twirl', line: 'Okay, I’m dizzy now.' };
  const n = POKE_BEATS.length;
  const k = Number.isFinite(poke) ? Math.trunc(poke) : 0;
  return POKE_BEATS[((k % n) + n) % n];
}
