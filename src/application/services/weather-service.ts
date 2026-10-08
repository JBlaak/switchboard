/**
 * The current weather, cached, for the empty-state mascot.
 *
 * The empty screen asks every time it is shown, which is far more often than
 * the weather changes and far more often than a free API should be called. So
 * a result is reused for half an hour per location, and when a fetch fails —
 * offline, a timeout, a bad response — the last good value keeps being served
 * until it is three hours old: yesterday afternoon's sky is a worse answer than
 * none, but this morning's is fine.
 *
 * Never rejects. The mascot is decoration; a weather problem must not become
 * an error on the empty screen.
 */
import type { Weather, WeatherLocation } from '../../domain/weather/weather';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { WeatherSource } from '../ports/weather-source';

/** How long a fetched result is served without asking again. */
export const WEATHER_CACHE_MS = 30 * 60 * 1000;
/** How long a result may be served in place of a failed fetch. */
export const WEATHER_STALE_MS = 3 * 60 * 60 * 1000;

/** The two settings this reads, rather than the whole SettingsService. */
export interface WeatherSettings {
  weatherEnabled(): boolean;
  weatherLocation(): WeatherLocation;
}

interface CachedWeather {
  key: string;
  weather: Weather;
}

function locationKey(loc: WeatherLocation): string {
  return `${loc.latitude},${loc.longitude}`;
}

export class WeatherService {
  #cached: CachedWeather | null = null;

  constructor(private readonly deps: {
    source: WeatherSource;
    settings: WeatherSettings;
    clock: Clock;
    log: Logger;
  }) {}

  /** The weather at the configured location, or null when off or unknown. */
  async current(): Promise<Weather | null> {
    const { source, settings, clock, log } = this.deps;
    try {
      if (!settings.weatherEnabled()) return null;
      const location = settings.weatherLocation();
      const key = locationKey(location);
      const now = clock.now();

      const cached = this.#cached?.key === key ? this.#cached.weather : null;
      if (cached && now - cached.fetchedAt < WEATHER_CACHE_MS) return cached;

      let fresh: Weather | null = null;
      try {
        fresh = await source.current(location);
      } catch (err) {
        log.warn('[weather] fetch failed:', (err as Error).message);
      }
      if (fresh) {
        this.#cached = { key, weather: fresh };
        return fresh;
      }
      if (cached && now - cached.fetchedAt < WEATHER_STALE_MS) return cached;
      return null;
    } catch (err) {
      log.warn('[weather] failed:', (err as Error).message);
      return null;
    }
  }

  /** Resolve a place name the user typed, or null when there is no match. */
  async geocode(name: string): Promise<WeatherLocation | null> {
    const query = typeof name === 'string' ? name.trim() : '';
    if (!query) return null;
    try {
      return await this.deps.source.geocode(query);
    } catch (err) {
      this.deps.log.warn('[weather] geocode failed:', (err as Error).message);
      return null;
    }
  }
}
