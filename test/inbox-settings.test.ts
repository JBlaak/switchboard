/**
 * A project's settings for the managers (#412): Watch issues and Releases
 * are tagged, stored in its blob beside its launch overrides; and the
 * Planner URL in the global one.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    releasesTaggedOverride,
    resolveReleasesTagged,
    resolveWatchIssues,
    taggedRecently,
    withReleasesTagged,
    withWatchIssues,
} from '../src/domain/settings/inbox-settings';
import {resolvePlannerUrl} from '../src/domain/settings/settings';
import {withoutOverrides} from '../src/domain/settings/project-overrides';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-13T12:00:00Z');

test('a project is not watched for issues until it is switched on', () => {
    /* Then */
    assert.equal(resolveWatchIssues({}), false);
    assert.equal(resolveWatchIssues(null), false);
});

test('switching Watch issues on keeps the rest of the project’s blob', () => {
    /* Given */
    const blob = {worktree: true, savedPrompts: []};

    /* When */
    const next = withWatchIssues(blob, true);

    /* Then */
    assert.deepEqual(next, {worktree: true, savedPrompts: [], watchIssues: true});
    assert.equal(resolveWatchIssues(next), true);
});

test('switching Watch issues off drops the key', () => {
    /* When */
    const next = withWatchIssues({watchIssues: true, chrome: true}, false);

    /* Then */
    assert.deepEqual(next, {chrome: true});
});

test('resetting the launch settings leaves Watch issues and Releases are tagged alone', () => {
    /* When */
    const next = withoutOverrides({worktree: true, watchIssues: true, releasesTagged: false});

    /* Then */
    assert.deepEqual(next, {watchIssues: true, releasesTagged: false});
});

test('without an override Releases are tagged follows the detection', () => {
    /* Then */
    assert.equal(releasesTaggedOverride({}), null);
    assert.equal(resolveReleasesTagged({}, true), true);
    assert.equal(resolveReleasesTagged({}, false), false);
});

test('a detection that could not be made counts as not tagged', () => {
    /* Then */
    assert.equal(resolveReleasesTagged({}, null), false);
});

test('the project’s own say overrides the detection either way', () => {
    /* Then */
    assert.equal(resolveReleasesTagged(withReleasesTagged({}, false), true), false);
    assert.equal(resolveReleasesTagged(withReleasesTagged({}, true), false), true);
    assert.equal(resolveReleasesTagged(withReleasesTagged({}, true), null), true);
});

test('setting Releases are tagged back to detected drops the key', () => {
    /* When */
    const next = withReleasesTagged({releasesTagged: true, chrome: true}, null);

    /* Then */
    assert.deepEqual(next, {chrome: true});
});

test('a tag in the last 90 days means the releases are tagged', () => {
    /* Then */
    assert.equal(taggedRecently(new Date(NOW - 12 * DAY).toISOString(), NOW), true);
    assert.equal(taggedRecently(new Date(NOW - 90 * DAY).toISOString(), NOW), true);
});

test('a newest tag older than 90 days, or none, means they are not', () => {
    /* Then */
    assert.equal(taggedRecently(new Date(NOW - 91 * DAY).toISOString(), NOW), false);
    assert.equal(taggedRecently(null, NOW), false);
    assert.equal(taggedRecently('not a date', NOW), false);
});

test('the Planner URL is empty unless one is entered, and stored without a trailing slash', () => {
    /* Then */
    assert.equal(resolvePlannerUrl({}), '');
    assert.equal(resolvePlannerUrl({plannerUrl: ' https://planner.example.com/ '}), 'https://planner.example.com');
});
