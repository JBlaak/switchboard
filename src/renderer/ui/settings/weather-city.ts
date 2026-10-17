/**
 * The weather city field's lookup, without the field.
 *
 * A typed city only counts once it resolves to coordinates; until then (or if
 * it never does) the form keeps saving the last location that did. A result
 * for text that has since been typed over is dropped, and Save waits for a
 * lookup in flight before it reads the location.
 */
import { DEFAULT_WEATHER_LOCATION } from '../../../domain/weather/weather';
import type { WeatherLocation } from '../../../domain/weather/weather';

export interface WeatherCityReport {
  /** The place the weather is now for. */
  resolved(name: string): void;
  /** Why the typed city did not take, or empty. */
  warn(text: string): void;
}

export interface WeatherCityLookup {
  /**
   * The field committed `text`. `current` reads the field again once the
   * lookup lands, to tell whether it was typed over in the meantime.
   */
  change(text: string, current: () => string): void;
  /** The location to save, once any lookup in flight has finished. */
  settled(): Promise<WeatherLocation>;
}

export function weatherCityLookup(
  initial: WeatherLocation,
  geocode: (name: string) => Promise<WeatherLocation | null>,
  report: WeatherCityReport,
): WeatherCityLookup {
  let location = initial;
  let lookup: Promise<void> = Promise.resolve();

  return {
    change(text, current) {
      const name = text.trim();
      report.warn('');
      if (!name) {
        location = DEFAULT_WEATHER_LOCATION;
        report.resolved(DEFAULT_WEATHER_LOCATION.name);
        return;
      }
      lookup = geocode(name).then((found) => {
        if (current().trim() !== name) return; // typed over while resolving
        if (found) {
          location = found;
          report.resolved(found.name);
        } else {
          report.warn(` — couldn't find “${name}”; keeping ${location.name}.`);
        }
      }).catch(() => {
        report.warn(` — couldn't look up “${name}”; keeping ${location.name}.`);
      });
    },
    async settled() {
      await lookup;
      return location;
    },
  };
}
