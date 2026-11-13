/**
 * A bug's signals (#413): new, and trending on fixed event counts.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bugSignals, isNew, isTrending} from '../src/domain/inbox/signals';
import {bugFacts} from '../src/domain/inbox/bugs';
import {DAY, NOW, PROJECT, THRESHOLDS, bug, bugsnagError} from './support/inbox-fixtures';

test('a spike of three times the daily average and twenty events is trending', () => {
    /* Given: 7 quiet days of 2 a day would average 2; a 24 h of 30 lifts the week to 42, an average of 6 */
    const counts = {events24h: 30, events7d: 42};

    /* When */
    const trending = isTrending(counts, THRESHOLDS);

    /* Then: 30 ≥ 3 × 6 and 30 ≥ 20 */
    assert.equal(trending, true);
});

test('a steady bug is not trending however many events it has', () => {
    /* Given: 100 every day */
    const counts = {events24h: 100, events7d: 700};

    /* When */
    const trending = isTrending(counts, THRESHOLDS);

    /* Then: 100 < 3 × 100 */
    assert.equal(trending, false);
});

test('a spike under the minimum events is not trending', () => {
    /* Given: from nothing to 19 */
    const counts = {events24h: 19, events7d: 19};

    /* When */
    const trending = isTrending(counts, THRESHOLDS);

    /* Then */
    assert.equal(trending, false);
});

test('the thresholds from Settings are the ones used', () => {
    /* Given: 24 h of 10 on a week of 20, an average of about 2.9 */
    const counts = {events24h: 10, events7d: 20};

    /* When */
    const strict = isTrending(counts, THRESHOLDS);
    const loose = isTrending(counts, {multiplier: 2, minEvents: 5});

    /* Then */
    assert.equal(strict, false);
    assert.equal(loose, true);
});

test('an error first seen after its project was first synced is new', () => {
    /* Given */
    const watchingSince = NOW - 2 * DAY;
    const fresh = bug('fresh', {firstSeen: new Date(NOW - DAY).toISOString()});
    const old = bug('old', {firstSeen: new Date(NOW - 3 * DAY).toISOString()});

    /* When */
    const signals = [fresh, old].map((facts) => isNew(facts, watchingSince));

    /* Then */
    assert.deepEqual(signals, [true, false]);
});

test('only an open production error of severity error is new', () => {
    /* Given */
    const watchingSince = NOW - 2 * DAY;
    const firstSeen = new Date(NOW - DAY).toISOString();

    /* When */
    const warning = isNew(bug('w', {firstSeen, severity: 'warning'}), watchingSince);
    const staging = isNew(bug('s', {firstSeen, releaseStages: ['staging']}), watchingSince);
    const fixed = isNew(bug('f', {firstSeen, status: 'fixed'}), watchingSince);
    const unstaged = isNew(bug('u', {firstSeen, releaseStages: []}), watchingSince);

    /* Then: an app that reports no release stage counts as production */
    assert.deepEqual([warning, staging, fixed, unstaged], [false, false, false, true]);
});

test('a regression carries over: the page decides it, not the poll', () => {
    /* Given */
    const facts = bug('e1');

    /* When */
    const signals = bugSignals(facts, {watchingSince: NOW, thresholds: THRESHOLDS, regressed: true});

    /* Then */
    assert.equal(signals.regressed, true);
});

test('the 24 h and 7-day lists give each open error its trend counts', () => {
    /* Given */
    const open = [bugsnagError('a', {events: 500}), bugsnagError('b', {events: 40})];
    const day = [bugsnagError('a', {events: 30})];
    const week = [bugsnagError('a', {events: 42}), bugsnagError('b', {events: 3})];

    /* When */
    const facts = bugFacts(PROJECT, open, day, week);

    /* Then: an error missing from a window had no events in it */
    assert.deepEqual(
        facts.map((f) => [f.errorId, f.events, f.events24h, f.events7d]),
        [
            ['a', 500, 30, 42],
            ['b', 40, 0, 3],
        ],
    );
});

test('a capped 7-day list never counts fewer events than the day it holds', () => {
    /* Given */
    const open = [bugsnagError('a')];

    /* When */
    const [facts] = bugFacts(PROJECT, open, [bugsnagError('a', {events: 25})], []);

    /* Then */
    assert.equal(facts!.events7d, 25);
});

test('a bug keeps its project id when Bugsnag left it out of the error', () => {
    /* When */
    const [facts] = bugFacts(PROJECT, [bugsnagError('a', {projectId: ''})], [], []);

    /* Then */
    assert.equal(facts!.projectId, PROJECT);
});
