/**
 * Where the Patch family is out on an adventure, and what time of day it is
 * there.
 *
 * The place changes a few times a day, like a new outing, rather than on every
 * appearance: it is picked deterministically from the local date and the part
 * of the day, so it holds all morning and moves on at noon. The time of day
 * follows the real sunrise and sunset at the user's location when the weather
 * knows them, and plain clock hours when it does not.
 *
 * Like the calendar, everything reads local date parts, and the type values
 * match the ones in @jblaak/patch; they are declared here so the domain does
 * not depend on the package.
 */

export type PatchPlace =
    | 'campfire'
    | 'tents'
    | 'pier'
    | 'forest'
    | 'beach'
    | 'canal'
    | 'allotment'
    | 'dunes'
    | 'orchard'
    | 'stargazing'
    | 'tulips'
    | 'sledding';

/** The four outings of a day. */
export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

/** How the scene is lit; matches PatchTime in the package. */
export type SceneTime = 'morning' | 'day' | 'evening' | 'night';

/** Today's sunrise and sunset at the location, in epoch milliseconds. */
export interface SunTimes {
    sunrise: number;
    sunset: number;
}

export interface Adventure {
    part: DayPart;
    time: SceneTime;
    place: PatchPlace;
    /** `y-m-d:part` in local date parts: changes exactly when the adventure may. */
    key: string;
}

type Season = 'spring' | 'summer' | 'autumn' | 'winter';
type Sky = 'clear' | 'cloudy' | 'rain' | 'snow';

const HOUR_MS = 3_600_000;
/** August, as a local month index: the orchard has fruit from then on. */
const AUGUST = 7;

/** Local midnight of `now`'s day plus `hours`, in epoch milliseconds. */
function localHour(now: Date, hours: number): number {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours).getTime();
}

/**
 * An epoch moved onto `now`'s local day, keeping its local time of day. Sun
 * times fetched yesterday are then still a fine guess for today, rather than
 * making the whole day night.
 */
function onDayOf(now: Date, epoch: number): number {
    const at = new Date(epoch);
    if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) {
        return epoch;
    }
    return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        at.getHours(),
        at.getMinutes(),
        at.getSeconds(),
        at.getMilliseconds(),
    ).getTime();
}

/**
 * The part of the day `now` falls in.
 *
 * With sun times: night until sunrise, morning until noon, afternoon until
 * sunset, evening until 22:00 (or one hour after a sunset later than that),
 * then night. A sunrise after noon starts the day in the afternoon. Without
 * them: 6–12 morning, 12–18 afternoon, 18–22 evening, else night.
 */
export function dayPartAt(now: Date, sun: SunTimes | null): DayPart {
    if (!sun) {
        const hour = now.getHours();
        if (hour >= 6 && hour < 12) return 'morning';
        if (hour >= 12 && hour < 18) return 'afternoon';
        if (hour >= 18 && hour < 22) return 'evening';
        return 'night';
    }
    const t = now.getTime();
    const sunrise = onDayOf(now, sun.sunrise);
    const sunset = onDayOf(now, sun.sunset);
    const noon = localHour(now, 12);
    const late = localHour(now, 22);
    if (t < sunrise) return 'night';
    if (t < sunset) return t < noon && sunrise < noon ? 'morning' : 'afternoon';
    const eveningEnds = sunset >= late ? sunset + HOUR_MS : late;
    return t < eveningEnds ? 'evening' : 'night';
}

/** How a part of the day is lit. */
export function sceneTimeFor(part: DayPart): SceneTime {
    return part === 'afternoon' ? 'day' : part;
}

/**
 * FNV-1a, 32-bit, with a final mix: keys a day apart differ in one or two
 * characters, and plain FNV-1a leaves its low bits (the ones `% n` reads)
 * too alike for those to spread over the places.
 */
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

const DAYTIME: Record<Season, PatchPlace[]> = {
    spring: ['allotment', 'tulips', 'forest', 'dunes'],
    summer: ['beach', 'dunes', 'pier', 'forest', 'orchard'],
    autumn: ['forest', 'orchard', 'dunes', 'pier'],
    winter: ['canal', 'sledding', 'forest'],
};

/** Where the family may be, in priority order of the rules. */
function candidates(part: DayPart, month: number, season: Season, sky: Sky | null): PatchPlace[] {
    if (sky === 'rain') return ['tents'];
    const daytime = part === 'morning' || part === 'afternoon';
    if (sky === 'snow') return daytime ? ['sledding', 'canal'] : ['campfire', 'canal'];
    if (part === 'night') return sky === 'clear' ? ['campfire', 'stargazing', 'tents'] : ['campfire', 'tents'];
    if (part === 'evening') {
        return [
            'campfire',
            'pier',
            'tents',
            ...(season === 'winter' ? (['canal'] as const) : []),
            ...(season === 'summer' ? (['dunes'] as const) : []),
        ];
    }
    const pool = DAYTIME[season];
    return month >= AUGUST ? pool : pool.filter((place) => place !== 'orchard');
}

const PREVIOUS: Record<DayPart, DayPart | null> = {
    morning: null,
    afternoon: 'morning',
    evening: 'afternoon',
    night: 'evening',
};

function dateKey(now: Date): string {
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

/** The place for one part of `now`'s local day, never the previous part's. */
function placeFor(now: Date, part: DayPart, season: Season, sky: Sky | null): PatchPlace {
    const pool = candidates(part, now.getMonth(), season, sky);
    const start = hash(`${dateKey(now)}:${part}`) % pool.length;
    const pick = pool[start];
    const previous = PREVIOUS[part];
    if (pool.length < 2 || previous === null) return pick;
    return pick === placeFor(now, previous, season, sky) ? pool[(start + 1) % pool.length] : pick;
}

/** Where the family is now, and how the scene is lit. */
export function adventureAt(now: Date, sun: SunTimes | null, season: Season, sky: Sky | null): Adventure {
    const part = dayPartAt(now, sun);
    return {
        part,
        time: sceneTimeFor(part),
        place: placeFor(now, part, season, sky),
        key: `${dateKey(now)}:${part}`,
    };
}
