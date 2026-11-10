import {test} from 'node:test';
import assert from 'node:assert/strict';

import type {CheckRun, PullRequestStatus} from '../src/domain/session-work/model';
import {needsYou, statusDot, worstStatusDot} from '../src/domain/session-work/status';

const REPO = 'owner/repo';

function pr(more: Partial<PullRequestStatus> = {}): PullRequestStatus {
    return {
        number: 7,
        url: `https://github.com/${REPO}/pull/7`,
        repository: REPO,
        closes: [],
        state: 'open',
        behindBy: 0,
        mergeable: 'mergeable',
        headSha: 'aaa',
        checks: [],
        ...more,
    };
}

const check = (name: string, state: CheckRun['state']): CheckRun => ({name, state});

// statusDot

test('green when passing, amber when running, red when failing', () => {
    /* Given */
    const cases: [PullRequestStatus, string][] = [
        [pr({checks: [check('ci', 'passing')]}), 'green'],
        [pr({checks: []}), 'green'],
        [pr({checks: [check('ci', 'passing'), check('e2e', 'pending')]}), 'amber'],
        [pr({checks: [check('ci', 'failing'), check('e2e', 'pending')]}), 'red'],
    ];

    for (const [status, expected] of cases) {
        /* When */
        const dot = statusDot(status);

        /* Then */
        assert.equal(dot, expected);
    }
});

const waiting = () =>
    pr({threads: [{id: 't', path: 'a', line: 1, side: 'RIGHT', resolved: false, needsYou: true, comments: []}]});

test('a thread waiting on you means the PR needs you', () => {
    /* When */
    const needs = needsYou(waiting());

    /* Then */
    assert.equal(needs, true);
});

test('red once it needs you', () => {
    /* When */
    const dot = statusDot(waiting());

    /* Then */
    assert.equal(dot, 'red');
});

test('a merged PR is merged, whatever its checks say', () => {
    /* Given */
    const status = pr({state: 'merged', checks: [check('ci', 'failing')]});

    /* When */
    const dot = statusDot(status);

    /* Then */
    assert.equal(dot, 'merged');
});

test('a closed PR is green', () => {
    /* Given */
    const status = pr({state: 'closed'});

    /* When */
    const dot = statusDot(status);

    /* Then */
    assert.equal(dot, 'green');
});

test('the +N chip takes the worst of the PRs it hides', () => {
    /* Given */
    const cases: [Parameters<typeof worstStatusDot>[0], string | null][] = [
        [[], null],
        [['green', 'green'], 'green'],
        [['green', 'amber', 'green'], 'amber'],
        [['amber', 'red', 'green'], 'red'],
        [['merged', 'merged'], 'merged'],
        [['merged', 'green'], 'green'],
    ];

    for (const [dots, expected] of cases) {
        /* When */
        const worst = worstStatusDot(dots);

        /* Then */
        assert.equal(worst, expected);
    }
});
