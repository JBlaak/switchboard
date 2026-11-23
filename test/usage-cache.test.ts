/**
 * The usage endpoint's last good week, kept for the Schedule manager.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {UsageCache} from '../src/application/services/usage-cache';
import type {Usage} from '../src/domain/usage/usage';

function cacheAnswering(...answers: Usage[]): UsageCache {
    return new UsageCache({fetch: async () => answers.shift()!});
}

test('nothing is known before the first fetch', () => {
    /* When */
    const week = cacheAnswering().latestWeek();

    /* Then */
    assert.equal(week, null);
});

test('a fetch keeps its all-models week', async () => {
    /* Given */
    const cache = cacheAnswering({weekAll: 41, session: 12});

    /* When */
    const usage = await cache.fetch();

    /* Then */
    assert.equal(usage.weekAll, 41);
    assert.equal(cache.latestWeek(), 41);
});

test('a rate-limited or failed fetch keeps the week before it', async () => {
    /* Given */
    const cache = cacheAnswering({weekAll: 41}, {_rateLimited: true, retryAfterSeconds: 60}, {_error: true});
    await cache.fetch();

    /* When */
    await cache.fetch();
    await cache.fetch();

    /* Then */
    assert.equal(cache.latestWeek(), 41);
});
