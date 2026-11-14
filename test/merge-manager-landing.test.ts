/**
 * The Landing shelf: each stage's colour, a lane's cycle, how long each of
 * the user's landed PRs still waits, the dots on the folded line (others in
 * a queue lane from the gaps in its numbers, a just-merged PR on its way
 * out), what the line says, and the shelf's fold in the session list slice.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {
    DEFAULT_CYCLE_MS,
    JUST_MERGED_MS,
    etaText,
    landingStrip,
    laneCycle,
    mergedAgo,
    stillText,
} from '../src/domain/merge-manager/landing';
import {stageTone, stageWords} from '../src/domain/merge-manager/stage-words';
import {landedKey, type LandedPullRequest, type LaneStage} from '../src/domain/merge-manager/model';
import {initialSessionListState, sessionListReducer} from '../src/renderer/state/session-list-slice';
import {HEAD, MIN, NOW, NO_RULES, landedPr} from './support/merge-manager-fixtures';

const WAITING: LaneStage = {kind: 'waiting', willConflict: false, position: null};
const HELD: LaneStage = {kind: 'held', reason: {kind: 'review', reviewer: 'ana', team: false}};
const FIXING: LaneStage = {kind: 'fixing', cause: 'checks'};
const CHANGES: LaneStage = {kind: 'needsYou', reason: {kind: 'changes-requested'}};
const REFUSED: LaneStage = {kind: 'needsYou', reason: {kind: 'merge-refused', reason: 'Branch protection'}};
const QUEUE = 'movelab/queued';

const merged = (number: number, landedMinutesAgo: number, mergedMinutesAgo: number): LandedPullRequest =>
    landedPr(number, landedMinutesAgo, 'switchboard', {kind: 'merged', at: NOW - mergedMinutesAgo * MIN});

const queued = (number: number, stage: LaneStage): LandedPullRequest =>
    landedPr(number, 30, 'queue', stage, {
        key: landedKey(QUEUE, number),
        repository: QUEUE,
        url: `https://github.com/${QUEUE}/pull/${number}`,
    });

const state = (prs: LandedPullRequest[]) => mergeManagerState(prs, new Map([['movelab/connect', NO_RULES]]));

// ── Tones ──

test('every stage has the colour the Merge manager draws it in', () => {
    /* Then */
    assert.equal(stageTone(HEAD), 'merging');
    assert.equal(stageTone({kind: 'merged', at: NOW}), 'merging');
    assert.equal(stageTone(WAITING), 'ready');
    assert.equal(stageTone(FIXING), 'progress');
    assert.equal(stageTone(CHANGES), 'progress');
    assert.equal(stageTone(HELD), 'blocked');
    assert.equal(stageTone(REFUSED), 'error');
});

test("a stage's words carry its colour", () => {
    /* Then */
    assert.equal(stageWords(REFUSED).tone, 'error');
    assert.equal(stageWords(WAITING).tone, 'ready');
});

// ── The cycle ──

test('a lane that has merged nothing yet takes the default cycle', () => {
    /* When */
    const cycle = laneCycle(state([landedPr(1, 10)]).lanes[0]!);

    /* Then */
    assert.equal(cycle, DEFAULT_CYCLE_MS);
});

test("a lane's cycle runs from when each merge could start: its landing, or the merge before it", () => {
    /* Given: #1 landed 60m ago and merged 50m ago (10m); #2 landed with it and merged 30m ago, 20m after #1; #3 landed 25m ago and merged 13m ago (12m) */
    const lane = state([merged(1, 60, 50), merged(2, 60, 30), merged(3, 25, 13)]).lanes[0]!;

    /* When */
    const cycle = laneCycle(lane);

    /* Then: the median of 10, 20 and 12 minutes */
    assert.equal(cycle, 12 * MIN);
});

test('a cycle is kept between three minutes and an hour and a half', () => {
    /* Then */
    assert.equal(laneCycle(state([merged(1, 61, 60)]).lanes[0]!), 3 * MIN);
    assert.equal(laneCycle(state([merged(1, 400, 100)]).lanes[0]!), 90 * MIN);
});

// ── Times ──

test('the head has what its step leaves of a cycle, and each waiting PR a cycle more per place', () => {
    /* Given: a 20 minute cycle; the head merging; two waiting behind it */
    const prs = [
        merged(1, 40, 20),
        landedPr(2, 30, 'switchboard', {kind: 'head', step: 'updating'}),
        landedPr(3, 20),
        landedPr(4, 10),
    ];

    /* When */
    const strip = landingStrip(state(prs), NOW);

    /* Then */
    const etas = strip.lanes[0]!.rows.map((row) => row.eta?.ms);
    assert.deepEqual(etas, [18 * MIN, 38 * MIN, 58 * MIN]);
    assert.equal(strip.next?.number, 2);
    assert.deepEqual(strip.allMerged, {ms: 58 * MIN, approximate: false});
});

test('a PR being fixed gets an approximate time, and a held one or one that needs you none', () => {
    /* Given */
    const prs = [
        landedPr(1, 30, 'switchboard', FIXING),
        landedPr(2, 20, 'switchboard', HELD),
        landedPr(3, 10, 'switchboard', CHANGES),
    ];

    /* When */
    const rows = landingStrip(state(prs), NOW).lanes[0]!.rows;

    /* Then */
    assert.deepEqual(
        rows.map((row) => [row.number, row.eta]),
        [
            [1, {ms: 2 * DEFAULT_CYCLE_MS, approximate: true}],
            [2, null],
            [3, null],
        ],
    );
});

test("in a queue lane a waiting PR counts the queue's places, someone else's head taken as half done", () => {
    /* Given: the user's PR is 3rd in a queue whose head is someone else's */
    const prs = [queued(7, {kind: 'waiting', willConflict: false, position: 3})];

    /* When */
    const strip = landingStrip(state(prs), NOW);

    /* Then */
    assert.equal(strip.lanes[0]!.rows[0]!.eta?.ms, DEFAULT_CYCLE_MS / 2 + 2 * DEFAULT_CYCLE_MS);
});

// ── The dots ──

test("a queue lane's dots fill the gaps in its numbers with other people's PRs, the first as the head", () => {
    /* Given */
    const prs = [queued(7, {kind: 'waiting', willConflict: false, position: 3})];

    /* When */
    const pips = landingStrip(state(prs), NOW).lanes[0]!.pips;

    /* Then */
    assert.deepEqual(
        pips.map((pip) => [pip.own, pip.tone, pip.head]),
        [
            [false, 'merging', true],
            [false, 'ready', false],
            [true, 'ready', false],
        ],
    );
});

test("a Switchboard lane's dots are the user's PRs in land order, each in its stage's colour", () => {
    /* Given */
    const prs = [landedPr(1, 30, 'switchboard', HEAD), landedPr(2, 20, 'switchboard', FIXING), landedPr(3, 10)];

    /* When */
    const pips = landingStrip(state(prs), NOW).lanes[0]!.pips;

    /* Then */
    assert.deepEqual(
        pips.map((pip) => [pip.tone, pip.head, pip.fixing]),
        [
            ['merging', true, false],
            ['progress', false, true],
            ['ready', false, false],
        ],
    );
});

test('a PR that just merged keeps its dot, gone, says so on the line, and tops Just merged', () => {
    /* Given */
    const prs = [
        landedPr(1, 60, 'switchboard', {kind: 'merged', at: NOW - 10_000}),
        merged(2, 120, 90),
        landedPr(3, 10),
    ];

    /* When */
    const strip = landingStrip(state(prs), NOW);

    /* Then */
    assert.equal(strip.justMerged?.number, 1);
    assert.deepEqual(
        strip.lanes[0]!.pips.map((pip) => [pip.key, pip.gone]),
        [
            [prs[0]!.key, true],
            [prs[2]!.key, false],
        ],
    );
    assert.deepEqual(
        strip.merged.map((pr) => pr.number),
        [1, 2],
    );
    assert.equal(strip.count, 1);
});

test('after a moment a merged PR leaves the line', () => {
    /* Given */
    const prs = [landedPr(1, 60, 'switchboard', {kind: 'merged', at: NOW - JUST_MERGED_MS}), landedPr(3, 10)];

    /* When */
    const strip = landingStrip(state(prs), NOW);

    /* Then */
    assert.equal(strip.justMerged, null);
    assert.equal(strip.lanes[0]!.pips.length, 1);
});

// ── When it shows ──

test('the shelf shows while anything is landed, and for a while after the last merge', () => {
    /* Then */
    assert.equal(landingStrip(state([]), NOW).visible, false);
    assert.equal(landingStrip(state([landedPr(1, 10)]), NOW).visible, true);
    assert.equal(landingStrip(state([merged(1, 30, 5)]), NOW).visible, true);
    assert.equal(landingStrip(state([merged(1, 60, 20)]), NOW).visible, false);
});

test('needs you counts the ones only the user can move, not the errors', () => {
    /* When */
    const strip = landingStrip(
        state([landedPr(1, 20, 'switchboard', CHANGES), landedPr(2, 10, 'switchboard', REFUSED)]),
        NOW,
    );

    /* Then */
    assert.equal(strip.needsYou, 1);
});

// ── Words ──

test('a time reads in minutes, then hours and minutes, approximate with a tilde', () => {
    /* Then */
    assert.equal(etaText({ms: 30_000, approximate: false}), '<1m');
    assert.equal(etaText({ms: 10 * MIN, approximate: false}), '10m');
    assert.equal(etaText({ms: 110 * MIN, approximate: false}), '1h 50m');
    assert.equal(etaText({ms: 120 * MIN, approximate: false}), '2h');
    assert.equal(etaText({ms: 35 * MIN, approximate: true}), '~35m');
});

test('a merge reads as how long ago', () => {
    /* Given */
    const prs = [merged(1, 60, 0), merged(2, 60, 12), merged(3, 300, 130)];
    const views = [...state(prs).lanes[0]!.pullRequests].sort((a, b) => a.number - b.number);

    /* Then */
    assert.deepEqual(
        views.map((pr) => mergedAgo(pr, NOW)),
        ['just now', '12m ago', '2h ago'],
    );
});

test('with nothing counting down, the line says why: an error, then needs you, then held', () => {
    /* Then */
    assert.deepEqual(stillText(landingStrip(state([landedPr(1, 10, 'switchboard', REFUSED)]), NOW)), {
        text: 'failed',
        tone: 'error',
    });
    assert.deepEqual(stillText(landingStrip(state([landedPr(1, 10, 'switchboard', CHANGES)]), NOW)), {
        text: 'needs you',
        tone: 'progress',
    });
    assert.deepEqual(stillText(landingStrip(state([landedPr(1, 10, 'switchboard', HELD)]), NOW)), {
        text: 'held',
        tone: 'blocked',
    });
});

// ── The fold ──

test('clicking the line unfolds the shelf, and again folds it', () => {
    /* When */
    const open = sessionListReducer(initialSessionListState, {type: 'landingShelfToggled'});
    const folded = sessionListReducer(open, {type: 'landingShelfToggled'});

    /* Then */
    assert.equal(initialSessionListState.landingShelfOpen, false);
    assert.equal(open.landingShelfOpen, true);
    assert.equal(folded.landingShelfOpen, false);
});
