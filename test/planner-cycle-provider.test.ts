/**
 * The Planner as a cycle provider (#412), against recorded answers from its
 * `GET /api/cycle/details`. No real Planner host: planner.example.com.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlannerCycleProvider} from '../src/infrastructure/planner/planner-cycle-provider';
import cycles from './fixtures/planner-cycles.json';

const PLANNER = 'https://planner.example.com';
const quiet = {warn: () => undefined};

/** A Planner whose current cycle is `current`; records every URL asked. */
function planner(current: keyof typeof cycles): {fetch: typeof fetch; asked: string[]} {
    const asked: string[] = [];
    const fetch = (async (input: string | URL) => {
        const url = new URL(String(input));
        asked.push(url.pathname + url.search);
        const wanted = (url.searchParams.get('cycle') ?? current) as keyof typeof cycles;
        const body = cycles[wanted];
        return body ? Response.json(body) : new Response('not found', {status: 404});
    }) as typeof globalThis.fetch;
    return {fetch, asked};
}

test('a day in the current cycle is answered from one question', async () => {
    /* Given */
    const fake = planner('42');
    const provider = new PlannerCycleProvider(quiet, {fetch: fake.fetch});

    /* When */
    const cycle = await provider.cycleOn(PLANNER, '2026-11-13');

    /* Then */
    assert.equal(cycle?.number, 42);
    assert.deepEqual(cycle?.cooldownAfter, {from: '2026-12-21', till: '2026-12-27'});
    assert.deepEqual(fake.asked, ['/api/cycle/details']);
});

test('a day before the Planner’s current cycle steps to the previous one', async () => {
    /* Given */
    const fake = planner('42');
    const provider = new PlannerCycleProvider(quiet, {fetch: fake.fetch});

    /* When */
    const cycle = await provider.cycleOn(PLANNER, '2026-11-01');

    /* Then */
    assert.equal(cycle?.number, 41);
    assert.deepEqual(fake.asked, ['/api/cycle/details', '/api/cycle/details?cycle=41']);
});

test('a day after the Planner’s current cycle steps to the next one', async () => {
    /* Given */
    const fake = planner('41');
    const provider = new PlannerCycleProvider(quiet, {fetch: fake.fetch});

    /* When */
    const cycle = await provider.cycleOn(PLANNER, '2026-11-02');

    /* Then */
    assert.equal(cycle?.number, 42);
    assert.deepEqual(fake.asked, ['/api/cycle/details', '/api/cycle/details?cycle=42']);
});

test('a trailing slash on the Planner URL is dropped', async () => {
    /* Given */
    const fake = planner('42');
    const provider = new PlannerCycleProvider(quiet, {fetch: fake.fetch});

    /* When */
    await provider.cycleOn(PLANNER + '/', '2026-11-13');

    /* Then */
    assert.deepEqual(fake.asked, ['/api/cycle/details']);
});

test('without a Planner URL nothing is asked', async () => {
    /* Given */
    const fake = planner('42');
    const provider = new PlannerCycleProvider(quiet, {fetch: fake.fetch});

    /* When */
    const cycle = await provider.cycleOn('  ', '2026-11-13');

    /* Then */
    assert.equal(cycle, null);
    assert.deepEqual(fake.asked, []);
});

test('an error answer gives no cycle', async () => {
    /* Given */
    const fetch = (async () => new Response('oops', {status: 500})) as typeof globalThis.fetch;
    const provider = new PlannerCycleProvider(quiet, {fetch});

    /* When */
    const cycle = await provider.cycleOn(PLANNER, '2026-11-13');

    /* Then */
    assert.equal(cycle, null);
});

test('an answer without the cycle dates gives no cycle', async () => {
    /* Given */
    const fetch = (async () =>
        Response.json({number: 42, from: '2026-11-02', till: '2026-12-20'})) as typeof globalThis.fetch;
    const provider = new PlannerCycleProvider(quiet, {fetch});

    /* When */
    const cycle = await provider.cycleOn(PLANNER, '2026-11-13');

    /* Then */
    assert.equal(cycle, null);
});

test('a Planner that cannot be reached gives no cycle', async () => {
    /* Given */
    const fetch = (async () => {
        throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const provider = new PlannerCycleProvider(quiet, {fetch});

    /* When */
    const cycle = await provider.cycleOn(PLANNER, '2026-11-13');

    /* Then */
    assert.equal(cycle, null);
});

test('a Planner that hangs is given up on at the deadline, even one that ignores the abort', async () => {
    /* Given */
    const fetch = (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch;
    const provider = new PlannerCycleProvider(quiet, {fetch, timeoutMs: 40});
    const started = Date.now();

    /* When */
    const cycle = await provider.cycleOn(PLANNER, '2026-11-13');

    /* Then */
    assert.equal(cycle, null);
    assert.ok(Date.now() - started < 1000, 'answered within the deadline');
});

test('one deadline covers the step to a neighbouring cycle too', async () => {
    /* Given: the current cycle answers at once, its neighbour never */
    const fetch = ((input: string | URL) =>
        String(input).includes('?cycle=')
            ? new Promise<Response>(() => undefined)
            : Promise.resolve(Response.json(cycles['42']))) as typeof globalThis.fetch;
    const provider = new PlannerCycleProvider(quiet, {fetch, timeoutMs: 40});
    const started = Date.now();

    /* When */
    const cycle = await provider.cycleOn(PLANNER, '2026-11-01');

    /* Then */
    assert.equal(cycle, null);
    assert.ok(Date.now() - started < 1000, 'answered within the deadline');
});
