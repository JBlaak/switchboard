/**
 * The weather, fetched once however many features ask at the same moment.
 *
 * Patch and the question panel both dress themselves in the sky, and both ask
 * for it as they install — which used to be two requests to main for one
 * answer. A call made while one is in flight shares it; a call after it has
 * settled asks again, because main keeps its own cache and decides when the
 * weather is stale.
 */
import type { Weather } from '../../domain/weather/weather';

let inFlight: Promise<Weather | null> | null = null;

/** Null when weather is switched off or could not be fetched; never rejects. */
export function fetchWeather(): Promise<Weather | null> {
  inFlight ??= window.api.getWeather()
    .catch(() => null)
    .finally(() => { inFlight = null; });
  return inFlight;
}
