/**
 * The Merge manager's page (#439): its tiles, its lanes (grouped, ordered,
 * empty ones left out, teammates faded), Merged today, the CI saved
 * estimate, what each row offers and the keys; the facts main answers for it;
 * and the page's part of the renderer slice.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeManagerState, teammateEntries} from '../src/domain/merge-manager/landed';
import {
    ciRunsSaved,
    dayStart,
    headSteps,
    mergeManagerTiles,
    mergedToday,
    pageLanes,
    pageSubline,
    rowActions,
    rowKeys,
    savedText,
    selectedRow,
    weekStart,
    type PageRow,
} from '../src/domain/merge-manager/page';
import {landedFacts} from '../src/domain/merge-manager/stages';
import {landedKey, type LandedPullRequest, type LaneStage} from '../src/domain/merge-manager/model';
import {QUEUE_LABELS} from '../src/domain/project/merge-queue';
import {MergeManagerPageService} from '../src/application/services/merge-manager-page-service';
import {mergeKeyAction} from '../src/renderer/ui/merge-manager/page-keys';
import {initialMergeManagerState, mergeManagerReducer} from '../src/renderer/state/merge-manager-slice';
import type {FixErrand} from '../src/domain/merge-manager/errands';
import {HEAD, ME, MIN, NOW, NO_RULES, REPO, RULES, landedPr, prRead} from './support/merge-manager-fixtures';

const QUEUE = 'movelab/queued';
const WAITING: LaneStage = {kind: 'waiting', willConflict: false, position: null};
const HELD_REVIEW: LaneStage = {kind: 'held', reason: {kind: 'review', reviewer: 'ana', team: false}};
const STOPPED: LaneStage = {kind: 'needsYou', reason: {kind: 'errand-stopped'}};

function queued(number: number, minutesAgo: number, stage: LaneStage): LandedPullRequest {
    return landedPr(number, minutesAgo, 'queue', stage, {
        key: landedKey(QUEUE, number),
        repository: QUEUE,
        url: `https://github.com/${QUEUE}/pull/${number}`,
    });
}

function row(lanes: ReturnType<typeof pageLanes>, number: number): PageRow {
    return lanes.flatMap((lane) => lane.rows).find((candidate) => candidate.number === number)!;
}

// ── Tiles ──

test("the tiles count the user's landed PRs by stage, and Merged today from local midnight", () => {
    /* Given */
    const today = dayStart(NOW);
    const state = mergeManagerState(
        [
            landedPr(1, 50, 'switchboard', HEAD),
            landedPr(2, 40, 'switchboard', {kind: 'waiting', willConflict: true, position: null}),
            landedPr(3, 30),
            landedPr(4, 20, 'switchboard', HELD_REVIEW),
            landedPr(5, 10, 'switchboard', {kind: 'fixing', cause: 'conflict'}),
            landedPr(6, 5, 'switchboard', STOPPED),
            landedPr(7, 300, 'switchboard', {kind: 'merged', at: today + 60 * MIN}),
            landedPr(8, 300, 'switchboard', {kind: 'merged', at: today - 60 * MIN}),
        ],
        new Map(),
    );

    /* When */
    const tiles = mergeManagerTiles(state, today);

    /* Then */
    assert.deepEqual(tiles, {
        needsYou: 1,
        fixing: 1,
        merging: 1,
        waiting: 2,
        willConflict: 1,
        held: 1,
        mergedToday: 1,
        lastMergedAt: today + 60 * MIN,
    });
});

test('CI runs saved is one run for each saving of every kind, and says what they were', () => {
    /* Given */
    const saved = {'update-not-pushed': 5, 'run-cancelled': 2, 'conflict-found': 1};

    /* When */
    const runs = ciRunsSaved(saved);

    /* Then */
    assert.equal(runs, 8);
    assert.equal(
        savedText(saved),
        '5 updates not pushed to waiting PRs, 2 runs cancelled behind the head, 1 conflict found by a local test rebase',
    );
    assert.equal(ciRunsSaved(null), 0);
    assert.equal(savedText({'update-not-pushed': 0, 'run-cancelled': 0, 'conflict-found': 0}), null);
});

test('the week starts on Monday at local midnight', () => {
    /* Given: Friday 13 November 2026, afternoon */
    const friday = new Date(2026, 10, 13, 15, 30).getTime();

    /* When */
    const start = weekStart(friday);

    /* Then */
    assert.equal(start, new Date(2026, 10, 9).getTime());
    assert.equal(weekStart(new Date(2026, 10, 15, 23, 0).getTime()), new Date(2026, 10, 9).getTime());
    assert.equal(weekStart(new Date(2026, 10, 16, 0, 1).getTime()), new Date(2026, 10, 16).getTime());
});

// ── Lanes ──

test('lanes are grouped by repository; a Switchboard lane has its head first, then the rest in land order', () => {
    /* Given: #3 landed first but is held; #2 is the head */
    const state = mergeManagerState(
        [
            landedPr(3, 50, 'switchboard', HELD_REVIEW),
            landedPr(2, 40, 'switchboard', HEAD),
            landedPr(4, 30),
            landedPr(5, 20, 'switchboard', STOPPED),
            queued(9, 10, WAITING),
        ],
        new Map(),
    );

    /* When */
    const lanes = pageLanes(state);

    /* Then */
    assert.deepEqual(
        lanes.map((lane) => [lane.repository, lane.kind]),
        [
            [REPO, 'switchboard'],
            [QUEUE, 'queue'],
        ],
    );
    assert.deepEqual(
        lanes[0].rows.map((candidate) => [candidate.number, candidate.order]),
        [
            [2, 1],
            [3, 2],
            [4, 3],
            [5, 4],
        ],
    );
});

test("a queue lane goes in the queue's order with teammates' entries among mine, faded and not landed", () => {
    /* Given */
    const teammates = teammateEntries(
        [
            prRead(20, {
                repository: QUEUE,
                author: 'sam',
                labels: [QUEUE_LABELS.optIn],
                automerge: {state: 'pending', description: 'First in the merge queue'},
            }),
            prRead(21, {
                repository: QUEUE,
                author: 'ana',
                labels: [QUEUE_LABELS.optIn],
                automerge: {state: 'pending', description: 'Number 3 in the merge queue'},
            }),
            prRead(22, {repository: QUEUE, labels: [QUEUE_LABELS.optIn]}),
            prRead(23, {repository: QUEUE, author: 'ben', labels: [QUEUE_LABELS.failed]}),
        ],
        ME,
        NOW,
    );
    const state = mergeManagerState(
        [
            queued(9, 30, {kind: 'waiting', willConflict: false, position: 2}),
            queued(8, 20, {kind: 'fixing', cause: 'checks'}),
        ],
        new Map(),
        {teammates: new Map([[QUEUE, teammates]])},
    );

    /* When */
    const [lane] = pageLanes(state);

    /* Then */
    assert.deepEqual(
        lane.rows.map((candidate) => [candidate.number, candidate.order, candidate.teammate !== null]),
        [
            [20, 1, true],
            [9, 2, false],
            [21, 3, true],
            [8, null, false],
        ],
    );
    assert.equal(row([lane], 20).landed, null);
    assert.equal(row([lane], 20).teammate?.author, 'sam');
});

test("a lane with nothing of the user's left in it is left out, merged PRs go to Merged today, newest first", () => {
    /* Given */
    const today = dayStart(NOW);
    const teammate = teammateEntries(
        [
            prRead(20, {
                repository: QUEUE,
                author: 'sam',
                labels: [QUEUE_LABELS.optIn],
                automerge: {state: 'pending', description: 'First in the merge queue'},
            }),
        ],
        ME,
        NOW,
    );
    const state = mergeManagerState(
        [
            landedPr(1, 50, 'switchboard', {kind: 'merged', at: today + 10 * MIN}),
            landedPr(2, 40, 'switchboard', {kind: 'merged', at: today + 20 * MIN}),
            queued(9, 30, {kind: 'merged', at: today + 5 * MIN}),
        ],
        new Map(),
        {teammates: new Map([[QUEUE, teammate]])},
    );

    /* When */
    const lanes = pageLanes(state);

    /* Then */
    assert.deepEqual(lanes, []);
    assert.equal(pageSubline(lanes), 'Nothing landed');
    assert.deepEqual(
        mergedToday(state, today).map((pr) => pr.number),
        [2, 1, 9],
    );
});

test('the selection falls back to the first row, and J/K move over the rows top to bottom', () => {
    /* Given */
    const lanes = pageLanes(mergeManagerState([landedPr(2, 40, 'switchboard', HEAD), landedPr(4, 30)], new Map()));

    /* When */
    const keys = rowKeys(lanes);

    /* Then */
    assert.deepEqual(keys, [landedKey(REPO, 2), landedKey(REPO, 4)]);
    assert.equal(selectedRow(lanes, null)?.number, 2);
    assert.equal(selectedRow(lanes, landedKey(REPO, 4))?.number, 4);
    assert.equal(selectedRow(lanes, 'gone#1')?.number, 2);
    assert.equal(selectedRow([], null), null);
});

test("the head card says how far its checks are: 'Checks 1 of 2' while they run", () => {
    /* Given */
    const read = prRead(2, {
        checks: [
            {name: 'Unit tests', state: 'passed', startedAt: NOW},
            {name: 'e2e', state: 'running', startedAt: NOW},
        ],
    });
    const facts = landedFacts(read, {...RULES, requiredChecks: ['Unit tests', 'e2e', 'lint']});
    const state = mergeManagerState([landedPr(2, 40, 'switchboard', {kind: 'head', step: 'checks'})], new Map(), {
        facts: new Map([[landedKey(REPO, 2), facts]]),
    });

    /* When */
    const steps = headSteps(row(pageLanes(state), 2));

    /* Then */
    assert.deepEqual(
        facts.checks.map((check) => check.state),
        ['passed', 'running', 'missing'],
    );
    assert.deepEqual(
        steps.map((step) => [step.label, step.state]),
        [
            ['Updated on the trunk', 'done'],
            ['Checks 1 of 3', 'active'],
            ['Merge', 'todo'],
        ],
    );
    assert.equal(landedFacts(read, NO_RULES).checks.length, 2);
});

// ── What a row offers, and the keys ──

test('each stage offers its actions; a teammate’s row only Nudge', () => {
    /* Given */
    const teammate = teammateEntries(
        [
            prRead(20, {
                repository: QUEUE,
                author: 'sam',
                labels: [QUEUE_LABELS.optIn],
                requestedReviewers: ['ana'],
                review: 'review_required',
                approvedBy: [],
                automerge: {state: 'pending', description: 'Waits for a review by @ana'},
            }),
        ],
        ME,
        NOW,
    );
    const state = mergeManagerState(
        [
            landedPr(1, 50, 'switchboard', HEAD),
            landedPr(2, 40, 'switchboard', {kind: 'fixing', cause: 'checks'}, {errand: 'errand-2'}),
            landedPr(3, 30, 'switchboard', STOPPED, {errand: 'errand-3'}),
            landedPr(4, 20, 'switchboard', HELD_REVIEW),
            landedPr(5, 10, 'switchboard', {kind: 'needsYou', reason: {kind: 'changes-requested'}}),
            queued(9, 5, WAITING),
        ],
        new Map(),
        {teammates: new Map([[QUEUE, teammate]])},
    );
    const lanes = pageLanes(state);

    /* When */
    const offers = [1, 2, 3, 4, 5, 20].map((number) => rowActions(row(lanes, number)));

    /* Then */
    assert.deepEqual(offers, [
        {open: {kind: 'session'}, tryAgain: false, nudge: null, unland: true},
        {open: {kind: 'errand', sessionId: 'errand-2'}, tryAgain: false, nudge: null, unland: true},
        {open: {kind: 'errand', sessionId: 'errand-3'}, tryAgain: true, nudge: null, unland: true},
        {open: {kind: 'session'}, tryAgain: false, nudge: 'ana', unland: true},
        {open: {kind: 'session'}, tryAgain: false, nudge: null, unland: true},
        {open: null, tryAgain: false, nudge: 'ana', unland: false},
    ]);
});

test('the keys act on the selected row only where it offers the action', () => {
    /* Given */
    const lanes = pageLanes(
        mergeManagerState(
            [landedPr(1, 50, 'switchboard', HEAD), landedPr(3, 30, 'switchboard', STOPPED, {errand: 'e3'})],
            new Map(),
        ),
    );
    const head = row(lanes, 1);
    const stopped = row(lanes, 3);

    /* When */
    const keys = ['j', 'ArrowUp', 'Enter', 't', 'n', 'u', 'o', 'x'].map(
        (key) => mergeKeyAction(key, head)?.kind ?? null,
    );

    /* Then */
    assert.deepEqual(keys, ['step', 'step', 'open', null, null, 'unland', 'github', null]);
    assert.equal(mergeKeyAction('t', stopped)?.kind, 'tryAgain');
    assert.equal(mergeKeyAction('Enter', null), null);
    assert.deepEqual(mergeKeyAction('k', null), {kind: 'step', step: -1});
});

// ── What main answers for the page ──

test("the page's facts: this week's savings in all and by repository, the errands and each lane's checkout", async () => {
    /* Given */
    const asked: number[] = [];
    const errand: FixErrand = {
        id: 'x',
        key: landedKey(REPO, 2),
        repository: REPO,
        number: 2,
        branch: 'branch-2',
        lane: 'switchboard',
        cause: 'conflict',
        headOid: 'oid-2',
        sessionId: 'launch',
        currentId: 'now',
        worktree: '/w',
        startedAt: NOW - 6 * MIN,
        finished: {outcome: 'pushed', note: 'Rebased past #1', at: NOW},
        stoppedAt: null,
    };
    const service = new MergeManagerPageService({
        manager: {state: () => mergeManagerState([landedPr(2, 40), queued(9, 30, WAITING)], new Map())},
        errands: {errands: () => [errand]},
        savings: {
            since: (at) => {
                asked.push(at);
                return {'update-not-pushed': 3, 'run-cancelled': 1, 'conflict-found': 0};
            },
            byRepository: () => ({[REPO]: {'update-not-pushed': 3, 'run-cancelled': 1, 'conflict-found': 0}}),
        },
        checkoutOf: async (repository) => (repository === REPO ? '/dev/connect' : null),
        clock: {now: () => NOW},
    });

    /* When */
    const facts = await service.facts();

    /* Then */
    assert.deepEqual(asked, [weekStart(NOW)]);
    assert.equal(ciRunsSaved(facts.savedThisWeek), 4);
    assert.deepEqual(Object.keys(facts.savedByRepository), [REPO]);
    assert.deepEqual(facts.errands, [
        {
            key: landedKey(REPO, 2),
            sessionId: 'now',
            cause: 'conflict',
            startedAt: NOW - 6 * MIN,
            state: 'finished',
            note: 'Rebased past #1',
        },
    ]);
    assert.deepEqual(facts.checkouts, {[REPO]: '/dev/connect'});
});

// ── The page's part of the slice ──

test('opening the page with a PR selects it; a Try again note is kept until it went, and a failure says why', () => {
    /* Given */
    const key = landedKey(REPO, 3);
    const opened = mergeManagerReducer(initialMergeManagerState, {type: 'mergeManagerPageRequested', key});
    const typed = mergeManagerReducer(opened, {type: 'mergeManagerTryAgainNoteTyped', key, note: 'Skip the flaky e2e'});

    /* When */
    const failed = mergeManagerReducer(mergeManagerReducer(typed, {type: 'mergeManagerTryAgainAsked', key}), {
        type: 'mergeManagerTryAgainAnswered',
        key,
        result: {ok: false, reason: '#3 has an errand running'},
    });
    const went = mergeManagerReducer(failed, {type: 'mergeManagerTryAgainAnswered', key, result: {ok: true}});

    /* Then */
    assert.equal(opened.page.selected, key);
    assert.equal(failed.page.notes[key], 'Skip the flaky e2e');
    assert.deepEqual(failed.page.tryAgain[key], {phase: 'failed', reason: '#3 has an errand running'});
    assert.equal(went.page.notes[key], undefined);
    assert.equal(went.page.tryAgain[key], undefined);
});

test('asking for the page again without a PR keeps the selection, and changes nothing when nothing would', () => {
    /* Given */
    const key = landedKey(REPO, 3);
    const opened = mergeManagerReducer(initialMergeManagerState, {type: 'mergeManagerPageRequested', key});

    /* When */
    const again = mergeManagerReducer(opened, {type: 'mergeManagerPageRequested'});

    /* Then */
    assert.strictEqual(again, opened);
});
