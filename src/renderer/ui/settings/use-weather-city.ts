/**
 * The weather city field's lookup.
 *
 * A typed city only counts once it resolves to coordinates; until then (or if
 * it never does) the form keeps saving the last location that did (see
 * `weatherCityLookup`). The lookup runs on the input's native `change` — on
 * blur or Enter, once the user is done typing — not on React's per-keystroke
 * `onChange`, so it is attached by hand.
 *
 * The lookup lives in a ref rather than state: Save awaits the lookup and then
 * reads the location, and both have to be the latest values at that moment,
 * not the ones of the render that made Save.
 */
import { useEffect, useRef, useState } from 'react';
import { geocodeCity } from './actions';
import { weatherCityLookup } from './weather-city';
import type { RefObject } from 'react';
import type { WeatherLocation } from '../../../domain/weather/weather';
import type { WeatherCityLookup } from './weather-city';

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
  const [resolvedName, setResolvedName] = useState(initial.name);
  const [warning, setWarning] = useState('');
  const lookup = useRef<WeatherCityLookup | null>(null);
  lookup.current ??= weatherCityLookup(initial, geocodeCity, { resolved: setResolvedName, warn: setWarning });

  useEffect(() => {
    const input = cityRef.current;
    if (!input) return;
    const onChange = (): void => lookup.current!.change(input.value, () => input.value);
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }, []);

  return {
    cityRef,
    resolvedName,
    warning,
    settled: () => lookup.current!.settled(),
  };
}
