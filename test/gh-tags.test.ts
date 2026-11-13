/**
 * A repository's newest tag (#412), mapped from recorded GraphQL answers.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toLatestTag} from '../src/infrastructure/github/gh-tags';

test('an annotated tag is dated by when it was tagged', () => {
    /* Given */
    const data = {
        repository: {
            refs: {
                nodes: [
                    {
                        name: 'v2.17.8',
                        target: {
                            tagger: {date: '2026-11-12T10:00:00+01:00'},
                            target: {committedDate: '2026-11-11T18:00:00Z'},
                        },
                    },
                ],
            },
        },
    };

    /* When */
    const latest = toLatestTag(data);

    /* Then */
    assert.deepEqual(latest, {at: '2026-11-12T10:00:00+01:00'});
});

test('a lightweight tag is dated by its commit', () => {
    /* Given */
    const data = {repository: {refs: {nodes: [{name: 'v1.0.0', target: {committedDate: '2026-08-01T09:00:00Z'}}]}}};

    /* When */
    const latest = toLatestTag(data);

    /* Then */
    assert.deepEqual(latest, {at: '2026-08-01T09:00:00Z'});
});

test('a repository without tags answers no date', () => {
    /* When */
    const latest = toLatestTag({repository: {refs: {nodes: []}}});

    /* Then */
    assert.deepEqual(latest, {at: null});
});

test('an answer without the repository is no answer', () => {
    /* When */
    const latest = toLatestTag({repository: null});

    /* Then */
    assert.equal(latest, null);
});
