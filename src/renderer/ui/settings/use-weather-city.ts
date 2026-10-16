/**
 * The weather city field's lookup.
 *
 * A typed city only counts once it resolves to coordinates; until then (or if
 * it never does) the form keeps saving the last location that did. The lookup
 * runs on the input's native `change` — on blur or Enter, once the user is done
 * typing — not on React's per-keystroke `onChange`, so it is attached by hand.
 *
 * The location and the lookup in flight live in refs rather than state: Save
 * awaits the lookup and then reads the location, and both have to be the
 * latest values at that moment, not the ones of the render that made Save.
 */
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_WEATHER_LOCATION } from '../../../domain/weather/weather';
import { geocodeCity } from './actions';
import type { RefObject } from 'react';
import type { WeatherLocation } from '../../../domain/weather/weather';

export interface WeatherCity {
  cityRef: RefObject<HTMLInputElement | null>;
  /** The place the weather is for, as last resolved. */
  resolvedName: string;
  /** Why the typed city did not take, or empty. */
  warning: string;
  /** The location to save, once any lookup in flight has finished. */
  settled(): Promise<WeatherLocation>;
}

export function useWeatherCity(initial: WeatherLocation): WeatherCity {
  const cityRef = useRef<HTMLInputElement | null>(null);
  const location = useRef(initial);
  const lookup = useRef<Promise<void>>(Promise.resolve());
  const [resolvedName, setResolvedName] = useState(initial.name);
  const [warning, setWarning] = useState('');

  useEffect(() => {
    const input = cityRef.current;
    if (!input) return;
    const onChange = (): void => {
      const name = input.value.trim();
      setWarning('');
      if (!name) {
        location.current = DEFAULT_WEATHER_LOCATION;
        setResolvedName(DEFAULT_WEATHER_LOCATION.name);
        return;
      }
      lookup.current = geocodeCity(name).then((found) => {
        if (input.value.trim() !== name) return; // typed over while resolving
        if (found) {
          location.current = found;
          setResolvedName(found.name);
        } else {
          setWarning(` — couldn't find “${name}”; keeping ${location.current.name}.`);
        }
      }).catch(() => {
        setWarning(` — couldn't look up “${name}”; keeping ${location.current.name}.`);
      });
    };
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }, []);

  return {
    cityRef,
    resolvedName,
    warning,
    async settled() {
      await lookup.current;
      return location.current;
    },
  };
}
