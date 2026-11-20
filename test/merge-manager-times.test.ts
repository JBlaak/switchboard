/**
 * When the user's landed PRs are expected to merge, on the Merge manager's
 * page: the head's time left, a run and a step per PR behind it, nothing for
 * the ones that keep their place, a queue lane by the queue's own numbers,
 * rough from place 3 on, and the timeline that lays it out, with flags where
 * the parked ones keep their place.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {pageLanes, type PageLane} from '../src/domain/merge-manager/page';
import {durationText, laneTimes, stillText, timeline, untilText} from '../src/domain/merge-manager/times';
import {landedKey, type LandedFacts, type LandedPullRequest, type LaneStage} from '../src/domain/merge-manager/model';
import {MIN, NOW, REPO, landedPr} from './support/merge-manager-fixtures';

const RUN = 10 * MIN;
const WAITING: LaneStage = {kind: 'waiting', willConflict: false, position: null};
const CHECKS: LaneStage = {kind: 'head', step: 'checks'};
const QUEUE = 'movelab/queued';

function laneOf(prs: LandedPullRequest[], facts = new Map<string, LandedFacts>()): PageLane {
    return pageLanes(mergeManagerState(prs, new Map(), {facts}))[0]!;
}

function queued(number: number, stage: LaneStage): LandedPullRequest {
    return landedPr(number, 30, 'queue', stage, {key: landedKey(QUEUE, number), repository: QUEUE});
}

test('the head has the rest of its run left, and each PR behind it a run and a step more', () => {
    /* Given */
    const facts: LandedFacts = {approvedBy: [], checks: [{name: 'Tests', state: 'running', startedAt: NOW - 4 * MIN}]};
    const lane = laneOf(
        [landedPr(1, 50, 'switchboard', CHECKS), landedPr(2, 40), landedPr(3, 30)],
        new Map([[landedKey(REPO, 1), facts]]),
    );

    /* When */
    const times = laneTimes(lane, RUN, NOW);

    /* Then */
    const [head, second, third] = [1, 2, 3].map((n) => times.rows.get(landedKey(REPO, n))!);
    // 10 min run, 4 min in, plus half a step.
    assert.equal(head.at, NOW + 6.5 * MIN);
    assert.equal(second.from, head.at);
    assert.equal(second.at, NOW + 17.5 * MIN);
    assert.equal(second.rough, false);
    // From place 3 on: rounded to 5 minutes, on the clock's 5 minutes.
    assert.equal(third.rough, true);
    assert.equal(third.minutes, 30);
    assert.equal(times.clearsAt, third.at);
});

test('Held, Fixing and Needs you keep their place and get no time, nor hold up the ones behind', () => {
    /* Given */
    const lane = laneOf([
        landedPr(1, 50, 'switchboard', {kind: 'head', step: 'updating'}),
        landedPr(2, 40, 'switchboard', {kind: 'held', reason: {kind: 'review', reviewer: 'ana', team: false}}),
        landedPr(3, 30, 'switchboard', {kind: 'fixing', cause: 'conflict'}),
        landedPr(4, 20),
    ]);

    /* When */
    const times = laneTimes(lane, RUN, NOW);

    /* Then */
    assert.deepEqual([...times.rows.keys()], [landedKey(REPO, 1), landedKey(REPO, 4)]);
    // Updating: a whole run and a step; then one more for #4.
    assert.equal(times.rows.get(landedKey(REPO, 4))!.at, NOW + 22 * MIN);
    assert.equal(stillText(lane.rows.find((row) => row.number === 2)!), 'keeps its place until it is reviewed');
    assert.equal(stillText(lane.rows.find((row) => row.number === 4)!), null);
});

test("a queue lane counts the queue's turns, other people's PRs included", () => {
    /* Given */
    const lane = laneOf([queued(7, {kind: 'waiting', willConflict: false, position: 2})]);

    /* When */
    const time = laneTimes(lane, RUN, NOW).rows.get(landedKey(QUEUE, 7))!;

    /* Then */
    // Someone else's head with half a run left, then this one's turn.
    assert.equal(time.at, NOW + 16 * MIN);
    assert.equal(time.from, NOW + 5 * MIN);
});

test('without a CI run to go by, nothing gets a time and there is no timeline', () => {
    /* Given */
    const lane = laneOf([landedPr(1, 50, 'switchboard', CHECKS), landedPr(2, 40, 'switchboard', WAITING)]);

    /* When */
    const times = laneTimes(lane, null, NOW);

    /* Then */
    assert.equal(times.rows.size, 0);
    assert.equal(times.clearsAt, null);
    assert.equal(timeline([lane], new Map([[lane.repository, times]]), NOW), null);
});

test('the timeline shows at least the next hour, out to the last merge, with a block per turn', () => {
    /* Given */
    const prs = [1, 2, 3, 4, 5, 6, 7].map((n) => landedPr(n, 60 - n, 'switchboard', n === 1 ? CHECKS : WAITING));
    const lane = laneOf(prs);
    const times = laneTimes(lane, RUN, NOW);

    /* When */
    const line = timeline([lane], new Map([[lane.repository, times]]), NOW)!;

    /* Then */
    // Six turns of 11 min behind a head with 5 min left: past the hour, so an hour and a half.
    assert.equal(line.to - line.from, 90 * MIN);
    assert.ok(line.ticks.every((at) => at > NOW && at < line.to && at % (30 * MIN) === 0));
    const blocks = line.tracks[0]!.blocks;
    assert.equal(blocks.length, 7);
    assert.equal(blocks[0]!.start, 0);
    assert.equal(blocks[0]!.head, true);
    assert.ok(blocks.every((block, i) => i === 0 || block.start >= blocks[i - 1]!.start));
    assert.ok(blocks.slice(2).every((block) => block.rough));
});

test('parked PRs get a flag at the end of the turn before them, one per spot, in the strongest tone', () => {
    /* Given */
    const lane = laneOf([
        landedPr(1, 50, 'switchboard', {kind: 'head', step: 'updating'}),
        landedPr(2, 45, 'switchboard', {kind: 'held', reason: {kind: 'review', reviewer: 'ana', team: false}}),
        landedPr(3, 40, 'switchboard', {kind: 'needsYou', reason: {kind: 'errand-stopped'}}),
        landedPr(4, 35),
        landedPr(5, 30, 'switchboard', {kind: 'fixing', cause: 'checks'}),
        landedPr(6, 25, 'switchboard', {kind: 'held', reason: {kind: 'approval'}}),
    ]);
    const times = laneTimes(lane, RUN, NOW);

    /* When */
    const line = timeline([lane], new Map([[lane.repository, times]]), NOW)!;

    /* Then */
    // The head has 11 min left, #4 a turn more: 22 min, of the hour shown.
    assert.equal(line.to - line.from, 60 * MIN);
    assert.deepEqual(line.tracks[0]!.flags, [
        {
            at: 11 / 60,
            keys: [landedKey(REPO, 2), landedKey(REPO, 3)],
            numbers: [2, 3],
            tone: 'needsYou',
            title: '#2 Held until @ana reviews it · #3 Needs you: the fix errand stopped without a fix',
        },
        {
            at: 22 / 60,
            keys: [landedKey(REPO, 5), landedKey(REPO, 6)],
            numbers: [5, 6],
            tone: 'fixing',
            title: '#5 A fix errand mends its failed checks · #6 Held until it is approved',
        },
    ]);
    assert.equal(line.tracks[0]!.blocks.length, 2);
});

test('a lane with only parked PRs is a track of flags at the start, even without a CI run to go by', () => {
    /* Given */
    const parked = laneOf([landedPr(1, 50, 'switchboard', {kind: 'held', reason: {kind: 'approval'}})]);
    const idle = laneOf([queued(7, WAITING)]);
    const times = new Map([
        [parked.repository, laneTimes(parked, null, NOW)],
        [idle.repository, laneTimes(idle, null, NOW)],
    ]);

    /* When */
    const line = timeline([parked, idle], times, NOW)!;
    const none = timeline([idle], times, NOW);

    /* Then */
    assert.equal(line.to - line.from, 60 * MIN);
    assert.deepEqual(
        line.tracks.map((track) => track.repository),
        [REPO],
    );
    assert.deepEqual(line.tracks[0]!.blocks, []);
    assert.deepEqual(
        line.tracks[0]!.flags.map((flag) => [flag.at, flag.numbers, flag.tone]),
        [[0, [1], 'held']],
    );
    assert.equal(none, null);
});

test('times read as minutes, hours and minutes, and rough ones with a tilde', () => {
    assert.equal(durationText(12 * MIN), '12 min');
    assert.equal(durationText(60 * MIN), '1 h');
    assert.equal(durationText(72 * MIN), '1 h 12 min');
    assert.equal(durationText(10_000), '1 min');
    assert.equal(untilText({from: NOW, at: NOW, minutes: 5, rough: false}), 'in 5 min');
    assert.equal(untilText({from: NOW, at: NOW, minutes: 30, rough: true}), 'in ~30 min');
});
