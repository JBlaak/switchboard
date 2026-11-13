/**
 * Seen again after the merge (#414): events after a Fix PR merged, judged
 * against the first tag that contains the merge: older releases ask you,
 * the fix's release or newer regress, and an untagged project always asks.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions, judgeSeenAgain, seenAgainLine, versionNumbers} from '../src/domain/inbox/seen-again';
import type {BugsnagEvent} from '../src/domain/bugsnag/model';
import type {FixTag} from '../src/domain/inbox/seen-again';

const TAG: FixTag = {name: 'v4.12.1', at: '2026-11-10T12:00:00Z'};

function event(appVersion: string | null, receivedAt = '2026-11-12T08:00:00Z'): BugsnagEvent {
    return {id: `e-${appVersion}-${receivedAt}`, receivedAt, appVersion, releaseStage: 'production'};
}

test('a version reads its numbers whether or not it has a v, a build or a prefix', () => {
    /* Then */
    assert.deepEqual(versionNumbers('v4.12.1'), [4, 12, 1]);
    assert.deepEqual(versionNumbers('4.12.1 (3121)'), [4, 12, 1]);
    assert.deepEqual(versionNumbers('release-4.12'), [4, 12]);
    assert.equal(versionNumbers('main'), null);
});

test('versions compare part by part, a missing part counting as 0', () => {
    /* Then */
    assert.ok(compareVersions([4, 12, 0], [4, 12, 1]) < 0);
    assert.ok(compareVersions([4, 13], [4, 12, 9]) > 0);
    assert.equal(compareVersions([4, 12], [4, 12, 0]), 0);
});

test('no events after the merge is no verdict', () => {
    /* Then */
    assert.equal(judgeSeenAgain([], TAG, true), null);
});

test('events only from a release older than the fix ask you, naming the version and the tag', () => {
    /* When */
    const verdict = judgeSeenAgain(
        [event('4.12.0'), event('4.11.3', '2026-11-11T08:00:00Z'), event('4.12.0')],
        TAG,
        true,
    );

    /* Then */
    assert.deepEqual(verdict, {kind: 'notice', events: 3, version: '4.12.0', tag: 'v4.12.1', tagged: true});
});

test('an event from the release with the fix is a regression', () => {
    /* When */
    const verdict = judgeSeenAgain([event('4.12.0'), event('4.12.1')], TAG, true);

    /* Then */
    assert.deepEqual(verdict, {kind: 'regressed'});
});

test('an event from a newer release than the fix is a regression, the v ignored', () => {
    /* When */
    const verdict = judgeSeenAgain([event('v4.13.0')], TAG, true);

    /* Then */
    assert.deepEqual(verdict, {kind: 'regressed'});
});

test('an event without a version is judged by the tag date: after it regresses', () => {
    /* When */
    const verdict = judgeSeenAgain([event(null, '2026-11-11T08:00:00Z')], TAG, true);

    /* Then */
    assert.deepEqual(verdict, {kind: 'regressed'});
});

test('an event without a version received before the tag was made asks you', () => {
    /* When */
    const verdict = judgeSeenAgain([event(null, '2026-11-09T08:00:00Z')], TAG, true);

    /* Then */
    assert.equal(verdict?.kind, 'notice');
});

test('a tag without numbers is judged by its date', () => {
    /* Given */
    const tag: FixTag = {name: 'spring-release', at: '2026-11-10T12:00:00Z'};

    /* When */
    const before = judgeSeenAgain([event('4.12.0', '2026-11-09T08:00:00Z')], tag, true);
    const after = judgeSeenAgain([event('4.12.0', '2026-11-11T08:00:00Z')], tag, true);

    /* Then */
    assert.equal(before?.kind, 'notice');
    assert.equal(after?.kind, 'regressed');
});

test('a project without release tags always asks, even for a newer version', () => {
    /* When */
    const verdict = judgeSeenAgain([event('9.0.0')], TAG, false);

    /* Then */
    assert.deepEqual(verdict, {kind: 'notice', events: 1, version: '9.0.0', tag: null, tagged: false});
});

test('a merge no tag contains yet asks, since every release so far lacks the fix', () => {
    /* When */
    const verdict = judgeSeenAgain([event('4.12.1')], null, true);

    /* Then */
    assert.deepEqual(verdict, {kind: 'notice', events: 1, version: '4.12.1', tag: null, tagged: true});
});

test("the notice line names the events, their release and the fix's first tag", () => {
    /* When */
    const line = seenAgainLine({events: 3, version: '4.12.0', tag: 'v4.12.1', tagged: true});

    /* Then */
    assert.equal(
        line,
        'Seen again after the merge, but these 3 events come from 4.12.0, a release without the fix (first in v4.12.1). Close it again?',
    );
});
