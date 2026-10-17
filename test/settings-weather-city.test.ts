import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WEATHER_LOCATION } from '../src/domain/weather/weather';
import { weatherCityLookup } from '../src/renderer/ui/settings/weather-city';
import type { WeatherLocation } from '../src/domain/weather/weather';

const UTRECHT: WeatherLocation = { name: 'Utrecht', latitude: 52.09, longitude: 5.12 };
const BERLIN: WeatherLocation = { name: 'Berlin', latitude: 52.52, longitude: 13.4 };

/** A geocoder answering from `places`, failing for `failing`, and nothing for the rest. */
function geocoder(places: Record<string, WeatherLocation>, failing: string[] = []) {
  return async (name: string): Promise<WeatherLocation | null> => {
    if (failing.includes(name)) throw new Error('offline');
    return places[name] ?? null;
  };
}

/** A geocoder whose answers wait until `release` is called. */
function heldGeocoder(places: Record<string, WeatherLocation>) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { geocode: async (name: string) => { await held; return places[name] ?? null; }, release: () => release() };
}

/** What the lookup reported, last value of each. */
function recorder() {
  const seen: { resolved?: string; warning: string } = { warning: '' };
  return { seen, report: { resolved: (name: string) => { seen.resolved = name; }, warn: (text: string) => { seen.warning = text; } } };
}

test('a city that resolves becomes the place to save', async () => {
  /* Given */
  const { seen, report } = recorder();
  const lookup = weatherCityLookup(DEFAULT_WEATHER_LOCATION, geocoder({ utrecht: UTRECHT }), report);

  /* When */
  lookup.change(' utrecht ', () => 'utrecht');
  const saved = await lookup.settled();

  /* Then */
  assert.deepEqual(saved, UTRECHT);
  assert.equal(seen.resolved, 'Utrecht');
  assert.equal(seen.warning, '');
});

test('a city that is not found keeps the previous place, and says so', async () => {
  /* Given */
  const { seen, report } = recorder();
  const lookup = weatherCityLookup(DEFAULT_WEATHER_LOCATION, geocoder({}), report);

  /* When */
  lookup.change('Atlantis', () => 'Atlantis');
  const saved = await lookup.settled();

  /* Then */
  assert.deepEqual(saved, DEFAULT_WEATHER_LOCATION);
  assert.equal(seen.resolved, undefined);
  assert.equal(seen.warning, ' — couldn\'t find “Atlantis”; keeping Amsterdam.');
});

test('a lookup that fails keeps the previous place, and says so', async () => {
  /* Given */
  const { seen, report } = recorder();
  const lookup = weatherCityLookup(DEFAULT_WEATHER_LOCATION, geocoder({}, ['Utrecht']), report);

  /* When */
  lookup.change('Utrecht', () => 'Utrecht');
  const saved = await lookup.settled();

  /* Then */
  assert.deepEqual(saved, DEFAULT_WEATHER_LOCATION);
  assert.equal(seen.warning, ' — couldn\'t look up “Utrecht”; keeping Amsterdam.');
});

test('the warning names the place last resolved, not the first', async () => {
  /* Given */
  const { seen, report } = recorder();
  const lookup = weatherCityLookup(DEFAULT_WEATHER_LOCATION, geocoder({ Utrecht: UTRECHT }), report);
  lookup.change('Utrecht', () => 'Utrecht');
  await lookup.settled();

  /* When */
  lookup.change('Atlantis', () => 'Atlantis');
  await lookup.settled();

  /* Then */
  assert.equal(seen.warning, ' — couldn\'t find “Atlantis”; keeping Utrecht.');
});

test('a new change clears the last warning', async () => {
  /* Given */
  const { seen, report } = recorder();
  const lookup = weatherCityLookup(DEFAULT_WEATHER_LOCATION, geocoder({ Utrecht: UTRECHT }), report);
  lookup.change('Atlantis', () => 'Atlantis');
  await lookup.settled();

  /* When */
  lookup.change('Utrecht', () => 'Utrecht');
  await lookup.settled();

  /* Then */
  assert.equal(seen.warning, '');
});

test('a result for text that has since been typed over is ignored', async () => {
  /* Given */
  const { seen, report } = recorder();
  const lookup = weatherCityLookup(DEFAULT_WEATHER_LOCATION, geocoder({ Berlin: BERLIN }), report);

  /* When */
  lookup.change('Berlin', () => 'Ber');
  const saved = await lookup.settled();

  /* Then */
  assert.deepEqual(saved, DEFAULT_WEATHER_LOCATION);
  assert.equal(seen.resolved, undefined);
});

test('settling waits for a lookup in flight', async () => {
  /* Given */
  const { report } = recorder();
  const held = heldGeocoder({ Berlin: BERLIN });
  const lookup = weatherCityLookup(DEFAULT_WEATHER_LOCATION, held.geocode, report);
  lookup.change('Berlin', () => 'Berlin');

  /* When */
  const saving = lookup.settled();
  held.release();

  /* Then */
  assert.deepEqual(await saving, BERLIN);
});

test('an empty city goes back to the default at once', async () => {
  /* Given */
  const { seen, report } = recorder();
  const lookup = weatherCityLookup(UTRECHT, geocoder({}), report);

  /* When */
  lookup.change('  ', () => '  ');
  const saved = await lookup.settled();

  /* Then */
  assert.deepEqual(saved, DEFAULT_WEATHER_LOCATION);
  assert.equal(seen.resolved, DEFAULT_WEATHER_LOCATION.name);
});
