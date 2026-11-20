/**
 * Not landed on the Merge manager's page: what the section shows (the newest
 * five, View all, left out when empty or landed), J/K's order through the
 * status groups (every not landed PR among them), which row the selection is on, the keys on a Not
 * landed row, what its side view says, the slice's Not landed events, and the
 * section drawn.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import './support/static-markup-dom';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {EMPTY_MERGE_MANAGER_STATE, landedKey} from '../src/domain/merge-manager/model';
import {notLandedKey, type OpenPullRequest} from '../src/domain/merge-manager/not-landed';
import {pageLanes} from '../src/domain/merge-manager/page';
import {
    beforeMerge,
    findSelection,
    ifLandedNow,
    nextRowKey,
    notLandedPageSubline,
    notLandedSection,
    notLandedSubline,
    pageSelection,
    visibleRowKeys,
    visibleRows,
} from '../src/renderer/ui/merge-manager/not-landed-rows';
import {notLandedKeyAction} from '../src/renderer/ui/merge-manager/page-keys';
import {initialMergeManagerState, mergeManagerReducer} from '../src/renderer/state/merge-manager-slice';
import {NotLandedSection} from '../src/renderer/ui/merge-manager/NotLandedSection';
import {HEAD, REPO, landedPr} from './support/merge-manager-fixtures';

const NOW = Date.UTC(2026, 10, 15, 10, 0);
const HOUR = 3_600_000;

function open(number: number, hoursAgo: number, over: Partial<OpenPullRequest> = {}): OpenPullRequest {
    return {
        repository: REPO,
        number,
        title: `PR ${number}`,
        url: `https://github.com/${REPO}/pull/${number}`,
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

/** #1 the head of the lane, #2 waiting behind it. */
const LANES = mergeManagerState([landedPr(1, 30, 'switchboard', HEAD), landedPr(2, 10)], new Map());

/** Seven open PRs: #1 and #2 are landed, #10..#16 are not, #16 the newest. */
const OPEN = [open(1, 50), open(2, 40), ...[10, 11, 12, 13, 14, 15, 16].map((n) => open(n, 20 - n))];

// ── The section ──

test('the section shows the newest five not in a lane, and how many View all adds', () => {
    /* Given */
    const prs = OPEN;

    /* When */
    const section = notLandedSection(prs, LANES);

    /* Then */
    assert.deepEqual(
        section.rows.map((pr) => pr.number),
        [16, 15, 14, 13, 12],
    );
    assert.equal(section.total, 7);
    assert.equal(section.more, 2);
});

test('the section has no rows before the first read or when every open PR is landed', () => {
    /* Given */
    const allLanded = [open(1, 2), open(2, 1)];

    /* When */
    const unread = notLandedSection(null, LANES);
    const landed = notLandedSection(allLanded, LANES);

    /* Then */
    assert.deepEqual(unread, {rows: [], total: 0, more: 0});
    assert.deepEqual(landed, {rows: [], total: 0, more: 0});
});

test('five or fewer need no View all', () => {
    /* Given */
    const prs = [open(10, 3), open(11, 2), open(12, 1)];

    /* When */
    const section = notLandedSection(prs, EMPTY_MERGE_MANAGER_STATE);

    /* Then */
    assert.equal(section.rows.length, 3);
    assert.equal(section.more, 0);
});

test('the header adds how many are not landed, and the Not landed page counts PRs and projects', () => {
    /* Given */
    const one = [open(10, 1)];

    /* When */
    const header = [notLandedSubline(0), notLandedSubline(3)];
    const sublines = [notLandedPageSubline(one, 1), notLandedPageSubline([...one, open(11, 2)], 2)];

    /* Then */
    assert.deepEqual(header, ['', ' · 3 not landed']);
    assert.deepEqual(sublines, [
        '1 open pull request of yours in 1 project · newest first',
        '2 open pull requests of yours in 2 projects · newest first',
    ]);
});

// ── Going through ──

function slice(view: 'lanes' | 'notLanded', repository: string | null = null) {
    return {
        ...initialMergeManagerState,
        state: LANES,
        notLanded: [...OPEN, open(20, 0.5, {repository: 'movelab/other'})],
        page: {...initialMergeManagerState.page, view, repository},
    };
}

test('J/K go through the status groups, every Not landed row among them', () => {
    /* Given */
    const state = slice('lanes');

    /* When */
    const keys = visibleRowKeys(visibleRows(state));

    /* Then */
    // Merging: the head #1; In line: #2; Waiting on review: the not landed ones, newest first.
    assert.deepEqual(keys, [
        landedKey(REPO, 1),
        landedKey(REPO, 2),
        landedKey('movelab/other', 20),
        ...[16, 15, 14, 13, 12, 11, 10].map((n) => landedKey(REPO, n)),
    ]);
});

test('a Not landed row that needs you comes before the lanes in J/K and as the first row', () => {
    /* Given */
    const state = {...slice('lanes'), notLanded: [...OPEN, open(30, 30, {checks: 'failure'})]};
    const rows = visibleRows(state);

    /* When */
    const keys = visibleRowKeys(rows);
    const first = pageSelection(rows, null);

    /* Then */
    assert.equal(keys[0], landedKey(REPO, 30));
    assert.equal(keys.length, 10);
    assert.equal(first?.kind, 'notLanded');
    assert.equal(first?.key, landedKey(REPO, 30));
});

test('on the Not landed page J/K keep its newest first order', () => {
    /* Given */
    const state = {...slice('notLanded'), notLanded: [open(30, 30, {checks: 'failure'}), open(31, 1)]};
    const rows = visibleRows(state);

    /* When */
    const keys = visibleRowKeys(rows);

    /* Then */
    assert.deepEqual(keys, [landedKey(REPO, 31), landedKey(REPO, 30)]);
    assert.equal(pageSelection(rows, null)?.key, landedKey(REPO, 31));
});

test("on the Not landed page J/K go through the chip's rows alone", () => {
    /* Given */
    const state = slice('notLanded', 'MOVELAB/other');

    /* When */
    const keys = visibleRowKeys(visibleRows(state));

    /* Then */
    assert.deepEqual(keys, [landedKey('movelab/other', 20)]);
});

test('a step moves within the rows, opens the current one first while the side view is closed', () => {
    /* Given */
    const keys = ['a', 'b', 'c'];

    /* When */
    const steps = [
        nextRowKey(keys, null, false, 1),
        nextRowKey(keys, null, false, -1),
        nextRowKey(keys, 'b', false, 1),
        nextRowKey(keys, 'b', true, 1),
        nextRowKey(keys, 'c', true, 1),
        nextRowKey(keys, 'a', true, -1),
        nextRowKey([], null, true, 1),
    ];

    /* Then */
    assert.deepEqual(steps, ['a', 'c', 'b', 'c', 'c', 'a', null]);
});

test('the selection finds a Not landed row by its key, and a landed one in its lane under the same key', () => {
    /* Given */
    const rows = visibleRows(slice('lanes'));

    /* When */
    const notLandedRow = findSelection(rows, landedKey(REPO, 15));
    const laneRow = findSelection(rows, landedKey(REPO, 2));
    const gone = findSelection(rows, landedKey(REPO, 99));

    /* Then */
    assert.equal(notLandedRow?.kind, 'notLanded');
    assert.equal(laneRow?.kind, 'lane');
    assert.equal(gone, null);
    assert.equal(pageSelection(rows, landedKey(REPO, 99))?.key, landedKey(REPO, 1));
});

test('with no lanes the selection falls back to the first Not landed row', () => {
    /* Given */
    const rows = {lanes: pageLanes(EMPTY_MERGE_MANAGER_STATE), notLanded: [open(10, 1)]};

    /* When */
    const selection = pageSelection(rows, null);

    /* Then */
    assert.equal(selection?.kind, 'notLanded');
    assert.equal(selection?.key, notLandedKey(open(10, 1)));
});

// ── Keys ──

test('on a Not landed row L lands it, ⏎ opens its session when there is one, O opens GitHub; T, N, U do nothing', () => {
    /* Given */
    const pr = open(10, 1);

    /* When */
    const kinds = ['l', 'Enter', 'o', 't', 'n', 'u', 'j', 'k'].map(
        (key) => notLandedKeyAction(key, pr, true)?.kind ?? null,
    );

    /* Then */
    assert.deepEqual(kinds, ['land', 'open', 'github', null, null, null, 'step', 'step']);
    assert.equal(notLandedKeyAction('Enter', pr, false), null);
});

test('L does nothing on a draft', () => {
    /* Given */
    const draft = open(10, 1, {isDraft: true});

    /* When */
    const action = notLandedKeyAction('l', draft, false);

    /* Then */
    assert.equal(action, null);
    assert.equal(notLandedKeyAction('o', draft, false)?.kind, 'github');
});

// ── The side view ──

test('before it can merge lists its checks, its conflicts and its approval', () => {
    /* Given */
    const ready = open(10, 1, {reviewDecision: 'APPROVED', approvedBy: ['ana']});
    const waiting = open(11, 1, {checks: 'pending', mergeable: 'CONFLICTING', reviewRequested: ['ben']});
    const asked = open(12, 1, {checks: null, reviewDecision: 'CHANGES_REQUESTED', changesRequestedBy: ['cy']});
    const nobody = open(13, 1, {checks: 'failure'});

    /* When */
    const lists = [ready, waiting, asked, nobody].map((pr) =>
        beforeMerge(pr).map((item) => item.tone + ':' + item.text),
    );

    /* Then */
    assert.deepEqual(lists, [
        ['done:Checks green', 'done:No conflicts with its base', 'done:Approved by ana'],
        ['running:Checks running', 'failing:Conflicts with its base', 'waiting:Review asked of ben'],
        ['none:No checks', 'done:No conflicts with its base', 'warn:Changes asked by cy'],
        ['failing:Checks failing', 'done:No conflicts with its base', 'none:No review asked'],
    ]);
});

test('landing it now: an approved PR waits its turn, any other is held until it is approved', () => {
    /* Given */
    const approved = open(10, 1, {reviewDecision: 'APPROVED'});
    const unreviewed = open(11, 1);

    /* When */
    const texts = [ifLandedNow(approved), ifLandedNow(unreviewed)];

    /* Then */
    assert.deepEqual(texts, [
        'It joins connect’s lane and waits its turn.',
        'It joins connect’s lane and is held there until it is approved. The Merge manager never approves for you.',
    ]);
});

// ── The slice ──

test('a Not landed read is kept with when it was read, and a failed one keeps the last good read and says it failed', () => {
    /* Given */
    const read = mergeManagerReducer(initialMergeManagerState, {
        type: 'mergeManagerNotLandedLoaded',
        pullRequests: [open(10, 1)],
        fetchedAt: 5_000,
        failed: false,
    });

    /* When */
    const failed = mergeManagerReducer(read, {
        type: 'mergeManagerNotLandedLoaded',
        pullRequests: null,
        fetchedAt: null,
        failed: true,
    });

    /* Then */
    assert.deepEqual(
        read.notLanded?.map((pr) => pr.number),
        [10],
    );
    assert.deepEqual([read.notLandedFetchedAt, read.notLandedFailed], [5_000, false]);
    assert.equal(failed.notLanded, read.notLanded);
    assert.deepEqual([failed.notLandedFetchedAt, failed.notLandedFailed], [5_000, true]);
});

test('View all closes the side view, a chip filters, and asking for the page again shows the lanes', () => {
    /* Given */
    const selected = mergeManagerReducer(initialMergeManagerState, {
        type: 'mergeManagerRowSelected',
        key: landedKey(REPO, 10),
    });

    /* When */
    const all = mergeManagerReducer(selected, {type: 'mergeManagerViewChanged', view: 'notLanded'});
    const chip = mergeManagerReducer(all, {type: 'mergeManagerNotLandedFiltered', repository: 'movelab/other'});
    const reopened = mergeManagerReducer(chip, {type: 'mergeManagerPageRequested'});

    /* Then */
    assert.equal(selected.page.detailOpen, true);
    assert.equal(all.page.view, 'notLanded');
    assert.equal(all.page.detailOpen, false);
    assert.equal(chip.page.repository, 'movelab/other');
    assert.equal(reopened.page.view, 'lanes');
});

// ── Drawn ──

test('the section draws five rows, Land it on all but a draft, and View all with how many more', () => {
    /* Given */
    const prs = [
        open(10, 1, {isDraft: true}),
        open(11, 2, {reviewDecision: 'APPROVED'}),
        ...[12, 13, 14, 15, 16].map((n) => open(n, 30 - n)),
    ];
    const section = notLandedSection(prs, EMPTY_MERGE_MANAGER_STATE);

    /* When */
    const html = renderToStaticMarkup(
        createElement(NotLandedSection, {section, now: NOW, selected: null, busy: {}, onSelect: () => {}}),
    );

    /* Then */
    assert.equal((html.match(/class="mm-row mm-nl-row/g) ?? []).length, 5);
    assert.equal((html.match(/data-land-key=/g) ?? []).length, 4);
    assert.match(html, /View all 7/);
    assert.match(html, /· 2 more/);
    assert.match(html, /land the chosen one/);
});

test('the section draws nothing when nothing is left unlanded', () => {
    /* Given */
    const section = notLandedSection([], EMPTY_MERGE_MANAGER_STATE);

    /* When */
    const html = renderToStaticMarkup(
        createElement(NotLandedSection, {section, now: NOW, selected: null, busy: {}, onSelect: () => {}}),
    );

    /* Then */
    assert.equal(html, '');
});

test('a ready row offers Land it as the primary button, a draft none and a dimmer title', () => {
    /* Given */
    const prs = [open(10, 2, {isDraft: true}), open(11, 1, {reviewDecision: 'APPROVED'})];
    const section = notLandedSection(prs, EMPTY_MERGE_MANAGER_STATE);

    /* When */
    const html = renderToStaticMarkup(
        createElement(NotLandedSection, {section, now: NOW, selected: null, busy: {}, onSelect: () => {}}),
    );

    /* Then */
    assert.match(html, /mm-nl-land is-ready" data-land-key="movelab\/connect#11"/);
    assert.match(html, /mm-nl-row is-draft/);
    assert.doesNotMatch(html, /data-land-key="movelab\/connect#10"/);
});
