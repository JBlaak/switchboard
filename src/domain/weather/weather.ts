/**
 * The weather outside, reduced to what the empty-state mascot can dress for.
 *
 * The forecast service speaks WMO weather codes — dozens of them, from "light
 * drizzle" to "thunderstorm with heavy hail". Patch has four outfits, so the
 * code is folded into a `Sky` here, along with the parsing of the two API
 * responses: both arrive from the network as untyped JSON, and turning a
 * malformed one into `null` rather than a half-filled object is a rule worth
 * testing without a socket.
 */

/** What the sky is doing, at the resolution the mascot cares about. */
export type Sky = 'clear' | 'cloudy' | 'rain' | 'snow';

/** A place to fetch the weather for. */
export interface WeatherLocation {
  name: string;
  latitude: number;
  longitude: number;
}

/** Used until the user picks a city of their own. */
export const DEFAULT_WEATHER_LOCATION: WeatherLocation = {
  name: 'Amsterdam',
  latitude: 52.3676,
  longitude: 4.9041,
};

/** The current weather, as handed to the renderer. */
export interface Weather {
  sky: Sky;
  isDay: boolean;
  /** The location's display name. */
  location: string;
  /** Epoch milliseconds the forecast was fetched at. */
  fetchedAt: number;
}

/**
 * Fold a WMO weather code into a `Sky`.
 *
 * Fog counts as cloudy and thunderstorms as rain. A code outside the table is
 * cloudy too — the most neutral outfit, and the least wrong guess.
 */
export function skyFromWmoCode(code: number): Sky {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3 || code === 45 || code === 48) return 'cloudy';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99)) {
    return 'rain';
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'cloudy';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The forecast response's `current` block, or null when it is not there.
 *
 * `is_day` is 1 or 0 on the wire; a boolean is accepted too.
 */
export function parseForecastResponse(
  body: unknown,
  location: WeatherLocation,
  fetchedAt: number,
): Weather | null {
  if (!isRecord(body) || !isRecord(body.current)) return null;
  const { weather_code: code, is_day: isDay } = body.current;
  if (!isFiniteNumber(code)) return null;
  if (isDay !== 0 && isDay !== 1 && typeof isDay !== 'boolean') return null;
  return {
    sky: skyFromWmoCode(code),
    isDay: isDay === 1 || isDay === true,
    location: location.name,
    fetchedAt,
  };
}

/**
 * The first geocoding match, or null when there is none or it is malformed.
 *
 * A search with no match omits `results` altogether rather than sending an
 * empty array, so both read as "not found".
 */
export function parseGeocodingResponse(body: unknown): WeatherLocation | null {
  if (!isRecord(body) || !Array.isArray(body.results)) return null;
  return parseWeatherLocation(body.results[0]);
}

/**
 * A location with a non-empty name and finite coordinates, or null.
 *
 * Also how a stored `weatherLocation` is read back: settings are an untyped
 * blob, so what was saved is checked before it is used.
 */
export function parseWeatherLocation(value: unknown): WeatherLocation | null {
  if (!isRecord(value)) return null;
  const { name, latitude, longitude } = value;
  if (typeof name !== 'string' || !name.trim()) return null;
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;
  return { name, latitude, longitude };
}
