import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    issueChip,
    issueTiles,
    issueWorkStage,
    polishArgs,
    polishFooter,
    readPolishRun,
    shownLabels,
    withPolishFooter,
} from '../src/domain/inbox/issue-manager';
import {markRead, startWork, syncSource} from '../src/domain/inbox/items';
import type {InboxItem} from '../src/domain/inbox/model';
import type {RepositoryPullRequest} from '../src/domain/project/overview';
import {ME, NOW, REPO, THRESHOLDS, issue} from './support/inbox-fixtures';

function arrived(...facts: ReturnType<typeof issue>[]): InboxItem[] {
    return syncSource([], facts, {now: NOW, complete: true, watchingSince: NOW, thresholds: THRESHOLDS, viewer: ME})
        .items;
}

function pr(number: number, fields: Partial<RepositoryPullRequest> = {}): RepositoryPullRequest {
    return {
        repository: REPO,
        number,
        title: 'Fix',
        state: 'open',
        draft: false,
        mine: true,
        headRef: '482-export',
        updatedAt: '2026-11-13T10:00:00Z',
        checks: {state: 'passing', failing: 0},
        review: 'approved',
        closes: [{repository: REPO, number: 482}],
        wait: {
            closedAt: null,
            failedChecks: [],
            cancelledChecks: [],
            reviewRequestedFromYou: false,
            reviewRequestedFromOthers: false,
            unresolvedThreads: 0,
            mergeable: 'mergeable',
            behindBase: null,
        },
        queue: {
            url: '',
            baseRef: 'main',
            labels: [],
            automerge: null,
            requestedReviewers: [],
            approvedBy: [],
            checks: [],
        },
        ...fields,
    };
}

// ── Labels ──

test('a row shows two labels and counts the rest', () => {
    /* Given */
    const labels = ['coach', 'export', 'web', 'bug'].map((name) => ({name, color: 'ededed'}));

    /* When */
    const {shown, more} = shownLabels(labels);

    /* Then */
    assert.deepEqual(
        shown.map((label) => label.name),
        ['coach', 'export'],
    );
    assert.equal(more, 2);
});

test('two labels or fewer show without a count', () => {
    /* When */
    const {shown, more} = shownLabels([{name: 'design', color: ''}]);

    /* Then */
    assert.equal(shown.length, 1);
    assert.equal(more, 0);
});

// ── The footer ──

test('a polished comment ends with the fixed footer naming whose notes it was', () => {
    /* When */
    const body = withPolishFooter('Thanks Pieter, I will pick this up.\n', 'joris');

    /* Then */
    assert.equal(
        body,
        "Thanks Pieter, I will pick this up.\n\n— Polished with Claude from joris's notes in Switchboard",
    );
});

test('a comment that already ends with the footer gets it once', () => {
    /* Given */
    const once = withPolishFooter('Thanks.', 'joris');

    /* When */
    const twice = withPolishFooter(once, 'joris');

    /* Then */
    assert.equal(twice, once);
    assert.equal(twice.split(polishFooter('joris')).length, 2);
});

test('the polish is one Haiku call with no tools, the prompt last', () => {
    /* When */
    const args = polishArgs('<notes>hi</notes>');

    /* Then */
    assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'haiku']);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args.at(-1), '<notes>hi</notes>');
});

test("the polish's answer is the comment; a failed or empty one is none", () => {
    /* Given */
    const ok = {exitCode: 0, stdout: JSON.stringify({type: 'result', result: '  Thanks, will do.  '}), stderr: ''};
    const failed = {exitCode: 1, stdout: JSON.stringify({type: 'result', result: 'x', is_error: true}), stderr: ''};
    const empty = {exitCode: 0, stdout: JSON.stringify({type: 'result', result: ' '}), stderr: ''};

    /* When */
    const answers = [ok, failed, empty].map(readPolishRun);

    /* Then */
    assert.deepEqual(answers, ['Thanks, will do.', null, null]);
});

// ── Why a row is unread ──

test('an issue never seen is new; seen and commented on since, it has new comments', () => {
    /* Given */
    const [fresh, seen] = arrived(issue(1), issue(2, {comments: 2}));
    const read = markRead(seen!);

    /* When */
    const woken = syncSource([read], [issue(2, {comments: 3, lastCommentBy: 'colleague'})], {
        now: NOW,
        complete: true,
        watchingSince: NOW,
        thresholds: THRESHOLDS,
        viewer: ME,
    }).items[0]!;

    /* Then */
    assert.equal(issueChip(fresh!), 'new');
    assert.equal(issueChip(read), null);
    assert.equal(issueChip(woken), 'comments');
});

test('the tiles count unread by why, and what is being worked on', () => {
    /* Given */
    const [a, b, c] = arrived(issue(1), issue(2), issue(3));

    /* When */
    const tiles = issueTiles([a!, markRead(b!), startWork(c!)]);

    /* Then */
    assert.deepEqual(tiles, {unread: 1, new: 1, comments: 0, inProgress: 1});
});

// ── Where a started issue stands ──

const ISSUE = {repository: REPO, number: 482};

test('without a PR that closes it, a started issue has no stage from GitHub', () => {
    /* When */
    const found = issueWorkStage([pr(9, {closes: [{repository: REPO, number: 1}]})], ISSUE);

    /* Then */
    assert.equal(found, null);
});

test("an open PR's checks and review give the stage", () => {
    /* When */
    const stages = [
        pr(10, {checks: {state: 'running', failing: 0}}),
        pr(11, {checks: {state: 'failing', failing: 1}}),
        pr(12, {review: 'review_required'}),
        pr(13),
        pr(14, {queue: {...pr(0).queue, labels: ['automerge:opt-in']}}),
    ].map((one) => issueWorkStage([one], ISSUE)?.stage);

    /* Then */
    assert.deepEqual(stages, ['prCi', 'ciFailing', 'prCi', 'ready', 'queue']);
});

test('a merged PR that closes it is merged, whatever else is open', () => {
    /* When */
    const found = issueWorkStage([pr(20), pr(18, {state: 'merged'})], ISSUE);

    /* Then */
    assert.deepEqual(found, {stage: 'merged', pullRequest: 18});
});
