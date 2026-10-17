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
  /* Given */
  const table: [number[], string][] = [
    [[0, 1], 'clear'],
    [[2, 3, 45, 48], 'cloudy'],
    [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99], 'rain'],
    [[71, 73, 75, 77, 85, 86], 'snow'],
  ];

  for (const [codes, sky] of table) {
    for (const code of codes) {
      /* When */
      const folded = skyFromWmoCode(code);

      /* Then */
      assert.strictEqual(folded, sky, `code ${code}`);
    }
  }
});

test('an unknown WMO code is cloudy', () => {
  /* Given */
  const unknown = [-1, 4, 10, 44, 50, 68, 70, 78, 79, 83, 84, 87, 94, 100, 1.5, NaN];

  for (const code of unknown) {
    /* When */
    const folded = skyFromWmoCode(code);

    /* Then */
    assert.strictEqual(folded, 'cloudy', `code ${code}`);
  }
});

// ── Response parsing ──

const amsterdam = DEFAULT_WEATHER_LOCATION;

test('a forecast response parses into the weather at that location', () => {
  /* Given */
  const body = { latitude: 52.37, current: { time: '2026-10-08T12:00', weather_code: 61, is_day: 1 } };

  /* When */
  const weather = parseForecastResponse(body, amsterdam, 1000);

  /* Then */
  assert.deepStrictEqual(weather, { sky: 'rain', isDay: true, location: 'Amsterdam', fetchedAt: 1000 });
});

test('a forecast response for the night parses as not day', () => {
  /* Given */
  const body = { current: { weather_code: 0, is_day: 0 } };

  /* When */
  const weather = parseForecastResponse(body, amsterdam, 0);

  /* Then */
  assert.strictEqual(weather?.isDay, false);
});

test('a malformed or incomplete forecast response parses to null', () => {
  /* Given */
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
    /* When */
    const weather = parseForecastResponse(body, amsterdam, 0);

    /* Then */
    assert.strictEqual(weather, null, JSON.stringify(body));
  }
});

test('a geocoding response parses into its first match', () => {
  /* Given */
  const body = {
    results: [
      { id: 2759794, name: 'Amsterdam', latitude: 52.37403, longitude: 4.88969, country: 'Netherlands' },
      { id: 1, name: 'Amsterdam', latitude: 42.9, longitude: -74.2 },
    ],
    generationtime_ms: 0.5,
  };

  /* When */
  const location = parseGeocodingResponse(body);

  /* Then */
  assert.deepStrictEqual(location, { name: 'Amsterdam', latitude: 52.37403, longitude: 4.88969 });
});

test('no match, or a malformed geocoding response, parses to null', () => {
  /* Given */
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
    /* When */
    const location = parseGeocodingResponse(body);

    /* Then */
    assert.strictEqual(location, null, JSON.stringify(body));
  }
});

// ── Settings ──

test('weather is on unless the global settings say otherwise', () => {
  /* Given */
  const cases: [Parameters<typeof resolveWeatherEnabled>[0], boolean][] = [
    [{}, true],
    [null, true],
    [{ weatherEnabled: false }, false],
  ];

  for (const [settings, expected] of cases) {
    /* When */
    const enabled = resolveWeatherEnabled(settings);

    /* Then */
    assert.strictEqual(enabled, expected, JSON.stringify(settings));
  }
});

test('weather is in Amsterdam unless the global settings hold a whole location', () => {
  /* Given */
  const oslo = { name: 'Oslo', latitude: 59.91, longitude: 10.75 };
  const cases: [Parameters<typeof resolveWeatherLocation>[0], WeatherLocation][] = [
    [{}, DEFAULT_WEATHER_LOCATION],
    [{ weatherLocation: { name: 'Oslo' } }, DEFAULT_WEATHER_LOCATION],
    [{ weatherLocation: oslo }, oslo],
  ];

  for (const [settings, expected] of cases) {
    /* When */
    const location = resolveWeatherLocation(settings);

    /* Then */
    assert.deepStrictEqual(location, expected, JSON.stringify(settings));
  }
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

test('a result is reused for 30 minutes', async () => {
  /* Given */
  const { state, service, advance } = setup();
  const first = await service.current();
  state.next = 'rain';

  /* When */
  advance(WEATHER_CACHE_MS - 1);
  const reused = await service.current();

  /* Then */
  assert.strictEqual(first?.sky, 'clear');
  assert.strictEqual(reused?.sky, 'clear');
  assert.strictEqual(state.fetches, 1);
});

test('a result is fetched again after 30 minutes', async () => {
  /* Given */
  const { state, service, advance } = setup();
  await service.current();
  state.next = 'rain';
  advance(WEATHER_CACHE_MS - 1);
  await service.current();

  /* When */
  advance(1);
  const fetched = await service.current();

  /* Then */
  assert.strictEqual(fetched?.sky, 'rain');
  assert.strictEqual(state.fetches, 2);
});

test('the cache is per location', async () => {
  /* Given */
  const { state, prefs, service } = setup();
  await service.current();
  prefs.location = oslo;

  /* When */
  const weather = await service.current();

  /* Then */
  assert.strictEqual(state.fetches, 2);
  assert.strictEqual(weather?.location, 'Oslo');
});

/** A service whose first fetch succeeded and whose next ones fail as given. */
async function failingAfterOneFetch(failure: null | 'throw') {
  const harness = setup();
  await harness.service.current();
  harness.state.next = failure;
  return harness;
}

const FAILURES = [null, 'throw'] as const;

test('a failed fetch serves the last good value once the cache is spent', async () => {
  for (const failure of FAILURES) {
    /* Given */
    const { service, advance } = await failingAfterOneFetch(failure);

    /* When */
    advance(WEATHER_CACHE_MS);
    const weather = await service.current();

    /* Then */
    assert.strictEqual(weather?.sky, 'clear', `${failure}: still fresh enough`);
  }
});

test('a failed fetch serves the last good value until just under 3 hours old', async () => {
  for (const failure of FAILURES) {
    /* Given */
    const { service, advance } = await failingAfterOneFetch(failure);
    advance(WEATHER_CACHE_MS);
    await service.current();

    /* When */
    advance(WEATHER_STALE_MS - WEATHER_CACHE_MS - 1);
    const weather = await service.current();

    /* Then */
    assert.strictEqual(weather?.sky, 'clear', `${failure}: just under 3h`);
  }
});

test('a failed fetch serves nothing once the last good value is 3 hours old', async () => {
  for (const failure of FAILURES) {
    /* Given */
    const { service, advance } = await failingAfterOneFetch(failure);
    advance(WEATHER_CACHE_MS);
    await service.current();
    advance(WEATHER_STALE_MS - WEATHER_CACHE_MS - 1);
    await service.current();

    /* When */
    advance(1);
    const weather = await service.current();

    /* Then */
    assert.strictEqual(weather, null, `${failure}: 3h old is too old`);
  }
});

test('a failed fetch keeps retrying', async () => {
  /* Given */
  const { state, service, advance } = await failingAfterOneFetch(null);
  advance(WEATHER_CACHE_MS);

  /* When */
  await service.current();
  await service.current();

  /* Then */
  assert.strictEqual(state.fetches, 3, 'a failure is not cached');
});

test('a success replaces the stale value', async () => {
  /* Given */
  const { state, service, advance } = await failingAfterOneFetch(null);
  advance(WEATHER_CACHE_MS);
  await service.current();
  await service.current();
  state.next = 'snow';

  /* When */
  const weather = await service.current();

  /* Then */
  assert.strictEqual(weather?.sky, 'snow');
});

test('a failure with nothing cached is null', async () => {
  /* Given */
  const { state, service } = setup();
  state.next = 'throw';

  /* When */
  const weather = await service.current();

  /* Then */
  assert.strictEqual(weather, null);
});

test('a failure with a value cached for another location is null', async () => {
  /* Given */
  const { state, prefs, service } = setup();
  state.next = 'throw';
  await service.current();
  state.next = 'clear';
  await service.current();
  state.next = null;
  prefs.location = oslo;

  /* When */
  const weather = await service.current();

  /* Then */
  assert.strictEqual(weather, null);
});

test('switched off, the service answers null without fetching', async () => {
  /* Given */
  const { state, prefs, service } = setup();
  prefs.enabled = false;

  /* When */
  const weather = await service.current();

  /* Then */
  assert.strictEqual(weather, null);
  assert.strictEqual(state.fetches, 0);
});

test('the service never rejects, even when reading settings throws', async () => {
  /* Given */
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

  /* When */
  const weather = await service.current();

  /* Then */
  assert.strictEqual(weather, null);
});

test('geocode trims the name', async () => {
  /* Given */
  const { state, service } = setup();
  state.found = oslo;

  /* When */
  const found = await service.geocode('  Oslo ');

  /* Then */
  assert.deepStrictEqual(found, oslo);
  assert.deepStrictEqual(state.geocodes, ['Oslo']);
});

test('geocode skips blanks', async () => {
  /* Given */
  const { state, service } = setup();
  state.found = oslo;
  await service.geocode('  Oslo ');

  /* When */
  const found = await service.geocode('   ');

  /* Then */
  assert.strictEqual(found, null);
  assert.strictEqual(state.geocodes.length, 1);
});

test('geocode swallows failures', async () => {
  /* Given */
  const { source } = fakeSource();
  source.geocode = async () => { throw new Error('offline'); };
  const failing = new WeatherService({
    source,
    settings: { weatherEnabled: () => true, weatherLocation: () => DEFAULT_WEATHER_LOCATION },
    clock: { now: () => 0 },
    log: silentLog,
  });

  /* When */
  const found = await failing.geocode('Oslo');

  /* Then */
  assert.strictEqual(found, null);
});
