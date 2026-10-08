/**
 * Open-Meteo, behind the weather source.
 *
 * Chosen because it needs no API key, so there is nothing to configure or leak.
 * The forecast and the geocoding search are separate hosts; both answer plain
 * JSON, which the domain parses. Never rejects: a timeout, a non-2xx and a body
 * that is not JSON all come back as null.
 */
import { parseForecastResponse, parseGeocodingResponse } from '../../domain/weather/weather';
import type { Weather, WeatherLocation } from '../../domain/weather/weather';
import type { Clock } from '../../application/ports/clock';
import type { Logger } from '../../application/ports/logger';
import type { WeatherSource } from '../../application/ports/weather-source';

const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const REQUEST_TIMEOUT_MS = 5000;

export class OpenMeteoWeatherSource implements WeatherSource {
  constructor(private readonly clock: Clock, private readonly log: Logger) {}

  async current(loc: WeatherLocation): Promise<Weather | null> {
    const url = new URL(FORECAST_ENDPOINT);
    url.searchParams.set('latitude', String(loc.latitude));
    url.searchParams.set('longitude', String(loc.longitude));
    url.searchParams.set('current', 'weather_code,is_day');
    const body = await this.#getJson(url);
    return body === null ? null : parseForecastResponse(body, loc, this.clock.now());
  }

  async geocode(name: string): Promise<WeatherLocation | null> {
    const url = new URL(GEOCODING_ENDPOINT);
    url.searchParams.set('name', name);
    url.searchParams.set('count', '1');
    const body = await this.#getJson(url);
    return body === null ? null : parseGeocodingResponse(body);
  }

  async #getJson(url: URL): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await globalThis.fetch(url, { signal: controller.signal });
      if (!res.ok) {
        this.log.warn(`[weather] ${url.host} answered ${res.status} ${res.statusText}`);
        return null;
      }
      return await res.json() as unknown;
    } catch (err) {
      this.log.warn(`[weather] ${url.host} failed:`, (err as Error).message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
