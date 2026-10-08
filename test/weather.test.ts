import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_WEATHER_LOCATION, parseForecastResponse, parseGeocodingResponse, skyFromWmoCode,
} from '../src/domain/weather/weather';
import { resolveWeatherEnabled, resolveWeatherLocation } from '../src/domain/settings/settings';
import {
  WEATHER_CACHE_MS, WEATHER_STALE_MS, WeatherService,
} from '../src/application/services/weather-service';
import { silentLog } from './support/fakes';
import type { Weather, WeatherLocation } from '../src/domain/weather/weather';
import type { WeatherSource } from '../src/application/ports/weather-source';

// ── WMO mapping ──

test('skyFromWmoCode folds every WMO code into one of four skies', () => {
  const table: [number[], string][] = [
    [[0, 1], 'clear'],
    [[2, 3, 45, 48], 'cloudy'],
    [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99], 'rain'],
    [[71, 73, 75, 77, 85, 86], 'snow'],
  ];
  for (const [codes, sky] of table) {
    for (const code of codes) assert.strictEqual(skyFromWmoCode(code), sky, `code ${code}`);
  }
});

test('an unknown WMO code is cloudy', () => {
  for (const code of [-1, 4, 10, 44, 50, 68, 70, 78, 79, 83, 84, 87, 94, 100, 1.5, NaN]) {
    assert.strictEqual(skyFromWmoCode(code), 'cloudy', `code ${code}`);
  }
});

// ── Response parsing ──

const amsterdam = DEFAULT_WEATHER_LOCATION;

test('a forecast response parses into the weather at that location', () => {
  const weather = parseForecastResponse(
    { latitude: 52.37, current: { time: '2026-10-08T12:00', weather_code: 61, is_day: 1 } },
    amsterdam, 1000,
  );
  assert.deepStrictEqual(weather, { sky: 'rain', isDay: true, location: 'Amsterdam', fetchedAt: 1000 });
  assert.strictEqual(
    parseForecastResponse({ current: { weather_code: 0, is_day: 0 } }, amsterdam, 0)?.isDay, false,
  );
});

test('a malformed or incomplete forecast response parses to null', () => {
  const bad: unknown[] = [
    null, undefined, 'nope', 42, [], {},
    { current: null },
    { current: [] },
    { current: { is_day: 1 } },
    { current: { weather_code: 3 } },
    { current: { weather_code: '3', is_day: 1 } },
    { current: { weather_code: 3, is_day: 2 } },
    { current: { weather_code: 3, is_day: 'yes' } },
    { current: { weather_code: Infinity, is_day: 1 } },
    { error: true, reason: 'Latitude must be in range of -90 to 90°.' },
  ];
  for (const body of bad) {
    assert.strictEqual(parseForecastResponse(body, amsterdam, 0), null, JSON.stringify(body));
  }
});

test('a geocoding response parses into its first match', () => {
  assert.deepStrictEqual(
    parseGeocodingResponse({
      results: [
        { id: 2759794, name: 'Amsterdam', latitude: 52.37403, longitude: 4.88969, country: 'Netherlands' },
        { id: 1, name: 'Amsterdam', latitude: 42.9, longitude: -74.2 },
      ],
      generationtime_ms: 0.5,
    }),
    { name: 'Amsterdam', latitude: 52.37403, longitude: 4.88969 },
  );
});

test('no match, or a malformed geocoding response, parses to null', () => {
  const bad: unknown[] = [
    null, 'nope', {},
    { generationtime_ms: 0.3 }, // what Open-Meteo sends for no match
    { results: [] },
    { results: {} },
    { results: [null] },
    { results: [{ latitude: 1, longitude: 2 }] },
    { results: [{ name: '', latitude: 1, longitude: 2 }] },
    { results: [{ name: 'X', longitude: 2 }] },
    { results: [{ name: 'X', latitude: '1', longitude: 2 }] },
  ];
  for (const body of bad) {
    assert.strictEqual(parseGeocodingResponse(body), null, JSON.stringify(body));
  }
});

// ── Settings ──

test('weather is on, in Amsterdam, unless the global settings say otherwise', () => {
  assert.strictEqual(resolveWeatherEnabled({}), true);
  assert.strictEqual(resolveWeatherEnabled(null), true);
  assert.strictEqual(resolveWeatherEnabled({ weatherEnabled: false }), false);
  assert.deepStrictEqual(resolveWeatherLocation({}), DEFAULT_WEATHER_LOCATION);
  assert.deepStrictEqual(resolveWeatherLocation({ weatherLocation: { name: 'Oslo' } }), DEFAULT_WEATHER_LOCATION);
  const oslo = { name: 'Oslo', latitude: 59.91, longitude: 10.75 };
  assert.deepStrictEqual(resolveWeatherLocation({ weatherLocation: oslo }), oslo);
});

// ── The service ──

const MINUTE = 60 * 1000;
const oslo: WeatherLocation = { name: 'Oslo', latitude: 59.91, longitude: 10.75 };

/** A source whose answers the test sets, counting the fetches it served. */
function fakeSource() {
  const state = {
    fetches: 0,
    /** What `current` does next: a sky, null (no answer), or 'throw'. */
    next: 'clear' as Weather['sky'] | null | 'throw',
    geocodes: [] as string[],
    found: null as WeatherLocation | null,
  };
  const clockRef = { now: 0 };
  const source: WeatherSource = {
    async current(loc) {
      state.fetches += 1;
      if (state.next === 'throw') throw new Error('offline');
      if (state.next === null) return null;
      return { sky: state.next, isDay: true, location: loc.name, fetchedAt: clockRef.now };
    },
    async geocode(name) {
      state.geocodes.push(name);
      return state.found;
    },
  };
  return { state, source, clockRef };
}

function setup() {
  const { state, source, clockRef } = fakeSource();
  const prefs = { enabled: true, location: DEFAULT_WEATHER_LOCATION };
  const service = new WeatherService({
    source,
    settings: { weatherEnabled: () => prefs.enabled, weatherLocation: () => prefs.location },
    clock: { now: () => clockRef.now },
    log: silentLog,
  });
  const advance = (ms: number) => { clockRef.now += ms; };
  return { state, prefs, service, advance };
}

test('a result is reused for 30 minutes, then fetched again', async () => {
  const { state, service, advance } = setup();
  assert.strictEqual((await service.current())?.sky, 'clear');
  state.next = 'rain';
  advance(WEATHER_CACHE_MS - 1);
  assert.strictEqual((await service.current())?.sky, 'clear');
  assert.strictEqual(state.fetches, 1);
  advance(1);
  assert.strictEqual((await service.current())?.sky, 'rain');
  assert.strictEqual(state.fetches, 2);
});

test('the cache is per location', async () => {
  const { state, prefs, service } = setup();
  await service.current();
  prefs.location = oslo;
  const weather = await service.current();
  assert.strictEqual(state.fetches, 2);
  assert.strictEqual(weather?.location, 'Oslo');
});

test('a failed fetch serves the last good value until it is 3 hours old', async () => {
  for (const failure of [null, 'throw'] as const) {
    const { state, service, advance } = setup();
    await service.current();
    state.next = failure;
    advance(WEATHER_CACHE_MS);
    assert.strictEqual((await service.current())?.sky, 'clear', `${failure}: still fresh enough`);
    advance(WEATHER_STALE_MS - WEATHER_CACHE_MS - 1);
    assert.strictEqual((await service.current())?.sky, 'clear', `${failure}: just under 3h`);
    advance(1);
    assert.strictEqual(await service.current(), null, `${failure}: 3h old is too old`);
  }
});

test('a failed fetch keeps retrying, and a success replaces the stale value', async () => {
  const { state, service, advance } = setup();
  await service.current();
  state.next = null;
  advance(WEATHER_CACHE_MS);
  await service.current();
  await service.current();
  assert.strictEqual(state.fetches, 3, 'a failure is not cached');
  state.next = 'snow';
  assert.strictEqual((await service.current())?.sky, 'snow');
});

test('a failure with nothing cached, or cached for another location, is null', async () => {
  const { state, prefs, service } = setup();
  state.next = 'throw';
  assert.strictEqual(await service.current(), null);
  state.next = 'clear';
  await service.current();
  state.next = null;
  prefs.location = oslo;
  assert.strictEqual(await service.current(), null);
});

test('switched off, the service answers null without fetching', async () => {
  const { state, prefs, service } = setup();
  prefs.enabled = false;
  assert.strictEqual(await service.current(), null);
  assert.strictEqual(state.fetches, 0);
});

test('the service never rejects, even when reading settings throws', async () => {
  const { source } = fakeSource();
  const service = new WeatherService({
    source,
    settings: {
      weatherEnabled: () => { throw new Error('db closed'); },
      weatherLocation: () => DEFAULT_WEATHER_LOCATION,
    },
    clock: { now: () => 0 },
    log: silentLog,
  });
  assert.strictEqual(await service.current(), null);
});

test('geocode trims the name, skips blanks, and swallows failures', async () => {
  const { state, service } = setup();
  state.found = oslo;
  assert.deepStrictEqual(await service.geocode('  Oslo '), oslo);
  assert.deepStrictEqual(state.geocodes, ['Oslo']);
  assert.strictEqual(await service.geocode('   '), null);
  assert.strictEqual(state.geocodes.length, 1);

  const { source } = fakeSource();
  source.geocode = async () => { throw new Error('offline'); };
  const failing = new WeatherService({
    source,
    settings: { weatherEnabled: () => true, weatherLocation: () => DEFAULT_WEATHER_LOCATION },
    clock: { now: () => 0 },
    log: silentLog,
  });
  assert.strictEqual(await failing.geocode('Oslo'), null);
});
