/**
 * A weather service as an external system.
 *
 * Two questions: what is the weather at a place, and where is a place called
 * this. Both answer null rather than rejecting when the service cannot say, so
 * the caching and fallback rules stay in the use case.
 */
import type { Weather, WeatherLocation } from '../../domain/weather/weather';

export interface WeatherSource {
  /** The current weather at a location, or null when it could not be fetched. */
  current(loc: WeatherLocation): Promise<Weather | null>;
  /** The best match for a place name, or null when there is none. */
  geocode(name: string): Promise<WeatherLocation | null>;
}
