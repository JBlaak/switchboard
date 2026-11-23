/**
 * The sidebar's pull request list: which PRs it shows and in what order,
 * what each row says and offers, the cursor's steps, the PR on screen, and
 * its keys.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {EMPTY_MERGE_MANAGER_STATE, landedKey, type LandedPullRequest} from '../src/domain/merge-manager/model';
import type {OpenPullRequest} from '../src/domain/merge-manager/not-landed';
import type {SessionWorkPage} from '../src/renderer/state/session-work-slice';
import type {SessionWorkSnapshot} from '../src/domain/session-work/model';
import {
    listKeys,
    listState,
    onScreenKey,
    pullRequestList,
    pullRequestListKey,
    pullRequestOnScreen,
    startListKey,
    stepListKey,
} from '../src/renderer/ui/sidebar-prs/pr-list-rows';
import {MIN, NOW, REPO, landedPr} from './support/merge-manager-fixtures';

const HOUR = 60 * MIN;
const OTHER = 'movelab/other';

function open(number: number, hoursAgo: number, over: Partial<OpenPullRequest> = {}): OpenPullRequest {
    const repository = over.repository ?? REPO;
    return {
        repository,
        number,
        title: `PR ${number}`,
        url: `https://github.com/${repository}/pull/${number}`,
        isDraft: false,
        createdAt: NOW - hoursAgo * HOUR,
        headRef: `branch-${number}`,
        reviewDecision: null,
        mergeable: 'MERGEABLE',
        checks: 'success',
        reviewRequested: [],
        changesRequestedBy: [],
        approvedBy: [],
        ...over,
    };
}

function lanes(prs: LandedPullRequest[]) {
    return mergeManagerState(prs, new Map());
}

function page(over: Partial<SessionWorkPage>): SessionWorkPage {
    return {
        sessionId: 's1',
        name: 'session',
        snapshot: null,
        selectedItemId: null,
        doneExpanded: false,
        diffMode: 'unified',
        diffs: {},
        composer: null,
        reviewPending: null,
        reviewError: null,
        wantedPullRequest: null,
        ...over,
    };
}

function keyOf(
    key: string,
    over: Partial<{metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean}> = {},
) {
    return {key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over};
}

test('the list shows landed and not landed PRs together, by repository, needs you first', () => {
    /* Given */
    const merge = lanes([
        landedPr(1, 30),
        landedPr(2, 20, 'switchboard', {kind: 'needsYou', reason: {kind: 'changes-requested'}}),
    ]);
    const prs = [
        open(1, 5),
        open(7, 1, {repository: OTHER, checks: 'failure'}),
        open(8, 2, {reviewDecision: 'APPROVED'}),
        open(9, 3, {isDraft: true}),
    ];

    /* When */
    const repos = pullRequestList(merge, prs);

    /* Then */
    assert.deepEqual(
        repos.map((repo) => [repo.name, repo.rows.map((row) => row.number)]),
        [
            ['connect', [2, 8, 1, 9]],
            ['other', [7]],
        ],
    );
});

test("each row says where it stands in the Merge manager's words, in its group's colour", () => {
    /* Given */
    const merge = lanes([
        landedPr(1, 30, 'switchboard', {kind: 'head', step: 'checks'}),
        landedPr(2, 20, 'switchboard', {kind: 'waiting', willConflict: false, position: null}),
    ]);
    const prs = [
        open(5, 1, {reviewDecision: 'APPROVED'}),
        open(6, 2, {checks: 'failure'}),
        open(7, 3, {reviewRequested: ['ana']}),
    ];

    /* When */
    const rows = pullRequestList(merge, prs).flatMap((repo) => repo.rows);

    /* Then */
    assert.deepEqual(
        rows.map((row) => [row.subline, row.tone]),
        [
            ['#6 · Checks failing', 'orange'],
            ['#1 · Head · checks', 'blue'],
            ['#5 · Ready to land', 'green'],
            ['#2 · Landed · 2nd', 'grey'],
            ['#7 · In review', 'grey'],
        ],
    );
});

test('Land it is offered on a not landed PR that is no draft, always shown once it is ready', () => {
    /* Given */
    const merge = lanes([landedPr(1, 30)]);
    const prs = [open(5, 1, {reviewDecision: 'APPROVED'}), open(6, 2), open(7, 3, {isDraft: true})];

    /* When */
    const rows = pullRequestList(merge, prs).flatMap((repo) => repo.rows);

    /* Then */
    assert.deepEqual(
        rows.map((row) => [row.number, row.land, row.draft]),
        [
            [5, 'ready', false],
            [1, null, false],
            [6, 'offered', false],
            [7, null, true],
        ],
    );
});

test("a PR that is landed shows once, at its lane's stage, though the open PRs still list it", () => {
    /* Given */
    const merge = lanes([landedPr(1, 30)]);

    /* When */
    const rows = pullRequestList(merge, [open(1, 5, {reviewDecision: 'APPROVED'})]).flatMap((repo) => repo.rows);

    /* Then */
    assert.equal(rows.length, 1);
    assert.equal(rows[0].open, null);
    assert.equal(rows[0].land, null);
});

test('before the first read the list is loading, then empty, or failed', () => {
    /* Given */
    const none = pullRequestList(EMPTY_MERGE_MANAGER_STATE, null);

    /* When */
    const states = [
        listState(0, {hasRead: false, failed: false}),
        listState(0, {hasRead: true, failed: false}),
        listState(0, {hasRead: false, failed: true}),
        listState(2, {hasRead: false, failed: true}),
    ];

    /* Then */
    assert.deepEqual(none, []);
    assert.deepEqual(states, ['loading', 'empty', 'failed', 'rows']);
});

test('the cursor steps through the rows and stops at either end', () => {
    /* Given */
    const keys = ['a', 'b', 'c'];

    /* When */
    const steps = [
        stepListKey(keys, null, 1),
        stepListKey(keys, null, -1),
        stepListKey(keys, 'a', 1),
        stepListKey(keys, 'c', 1),
        stepListKey(keys, 'a', -1),
        stepListKey(keys, 'gone', 1),
        stepListKey([], null, 1),
    ];

    /* Then */
    assert.deepEqual(steps, ['a', 'c', 'b', 'c', 'a', 'a', null]);
});

test('the cursor starts on the PR on screen, else on the first row', () => {
    /* Given */
    const repos = pullRequestList(lanes([]), [open(5, 1), open(6, 2)]);

    /* When */
    const onScreen = startListKey(repos, landedKey(REPO, 6));
    const elsewhere = startListKey(repos, landedKey(OTHER, 1));

    /* Then */
    assert.deepEqual(listKeys(repos), [landedKey(REPO, 5), landedKey(REPO, 6)]);
    assert.equal(onScreen, landedKey(REPO, 6));
    assert.equal(elsewhere, landedKey(REPO, 5));
});

test("the PR on screen is a PR page's own, or the one a session's work page is on", () => {
    /* Given */
    const snapshot = {
        sessionId: 's1',
        repository: REPO,
        items: [
            {
                id: 'pr-5',
                kind: 'pr',
                pr: {number: 5, url: '', repository: REPO, closes: []},
                location: null,
                diff: {kind: 'pull-request', repository: REPO, number: 5},
            },
        ],
        footprint: {worktrees: 0, branches: 0},
        gh: 'ok',
        updatedAt: '',
    } as SessionWorkSnapshot;

    /* When */
    const own = pullRequestOnScreen(
        {kind: 'sessionWork', sessionId: 'pull:movelab/connect#6'},
        page({sessionId: 'pull:movelab/connect#6'}),
    );
    const wanted = pullRequestOnScreen(
        {kind: 'sessionWork', sessionId: 's1'},
        page({wantedPullRequest: {repository: REPO, number: 7}}),
    );
    const selected = pullRequestOnScreen(
        {kind: 'sessionWork', sessionId: 's1'},
        page({snapshot, selectedItemId: 'pr-5'}),
    );
    const terminal = pullRequestOnScreen({kind: 'session', sessionId: 's1'}, page({snapshot, selectedItemId: 'pr-5'}));

    /* Then */
    assert.deepEqual(own, {repository: REPO, number: 6});
    assert.deepEqual(wanted, {repository: REPO, number: 7});
    assert.deepEqual(selected, {repository: REPO, number: 5});
    assert.equal(terminal, null);
});

test('the row on screen is found whatever the case of its repository', () => {
    /* Given */
    const repos = pullRequestList(lanes([]), [open(5, 1)]);

    /* When */
    const key = onScreenKey(repos, {repository: 'MoveLab/Connect', number: 5});

    /* Then */
    assert.equal(key, landedKey(REPO, 5));
    assert.equal(onScreenKey(repos, null), null);
});

test("the list's keys: arrows and J/K step, Enter opens, L lands, O opens GitHub, Esc leaves; chords are not its own", () => {
    /* Given */
    const keys = ['ArrowDown', 'ArrowUp', 'j', 'k', 'Enter', 'l', 'o', 'Escape', 'x'];

    /* When */
    const plain = keys.map((key) => pullRequestListKey(keyOf(key)));
    const chords = [
        pullRequestListKey(keyOf('l', {metaKey: true})),
        pullRequestListKey(keyOf('j', {ctrlKey: true})),
        pullRequestListKey(keyOf('o', {shiftKey: true})),
        pullRequestListKey(keyOf('Enter', {metaKey: true})),
    ];

    /* Then */
    assert.deepEqual(plain, ['down', 'up', 'down', 'up', 'open', 'land', 'github', 'leave', null]);
    assert.deepEqual(chords, [null, null, null, null]);
});
