/**
 * Each PR's own timeline on the Merge manager's page: the seven stations'
 * marks for every landed stage and not landed status, the lines under them,
 * how long the line took, the head's three steps, the stretch that fills now,
 * the sentence on what happens now, and the screen reader's label.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MIN_ESTIMATE_MS, QUEUE_STEP_MS} from '../src/domain/project/merge-queue';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {landedKey, type LandedFacts, type LandedPullRequest, type LaneStage} from '../src/domain/merge-manager/model';
import type {OpenPullRequest} from '../src/domain/merge-manager/not-landed';
import {pageLanes, type PageRow} from '../src/domain/merge-manager/page';
import {landedTimeline, notLandedTimeline, type PrTimeline} from '../src/domain/merge-manager/pr-timeline';
import type {RowTime} from '../src/domain/merge-manager/times';
import {HEAD, MIN, NOW, REPO, landedPr} from './support/merge-manager-fixtures';

const RUN = 10 * MIN;

/** "09:05", local, as the timeline writes it. */
function clock(at: number): string {
    const date = new Date(at);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

/** The rows of one lane of `prs`, by number. */
function rowsOf(prs: LandedPullRequest[], facts = new Map<string, LandedFacts>()): Map<number, PageRow> {
    const lane = pageLanes(mergeManagerState(prs, new Map(), {facts}))[0]!;
    return new Map(lane.rows.map((row) => [row.number, row]));
}

function rowAt(stage: LaneStage, facts?: LandedFacts): PageRow {
    const map = new Map<string, LandedFacts>();
    if (facts) map.set(landedKey(REPO, 1), facts);
    return rowsOf([landedPr(1, 50, 'switchboard', stage)], map).get(1)!;
}

function marks(line: PrTimeline): string[] {
    return line.stations.map((station) => station.mark);
}

function station(line: PrTimeline, id: string) {
    return line.stations.find((candidate) => candidate.id === id)!;
}

function parts(line: PrTimeline): string[] | null {
    return line.headParts?.map((part) => `${part.label}:${part.mark}`) ?? null;
}

function open(over: Partial<OpenPullRequest> = {}): OpenPullRequest {
    return {
        repository: REPO,
        number: 10,
        title: 'PR 10',
        url: `https://github.com/${REPO}/pull/10`,
        isDraft: false,
        createdAt: NOW - 3 * 60 * MIN,
        headRef: 'branch-10',
        reviewDecision: null,
        mergeable: 'MERGEABLE',
        checks: 'success',
        reviewRequested: [],
        changesRequestedBy: [],
        approvedBy: [],
        ...over,
    };
}

// ── Landed ──

test('the head running its checks: Head now, its checks step live, and when it merges', () => {
    /* Given */
    const facts: LandedFacts = {
        approvedBy: ['ben'],
        checks: [
            ...['a', 'b', 'c', 'd'].map((name) => ({name, state: 'passed' as const, startedAt: NOW - 4 * MIN})),
            {name: 'e', state: 'skipped', startedAt: null},
            ...['f', 'g', 'h'].map((name) => ({name, state: 'running' as const, startedAt: NOW - 3 * MIN})),
        ],
    };
    const row = rowAt({kind: 'head', step: 'checks'}, facts);
    const time: RowTime = {from: NOW, at: NOW + 4 * MIN, minutes: 4, rough: false};

    /* When */
    const line = landedTimeline(row, time, RUN, NOW);

    /* Then */
    assert.deepEqual(marks(line), ['done', 'done', 'done', 'done', 'done', 'now', 'todo']);
    assert.deepEqual(parts(line), ['update:done', 'checks 5 of 8:now', 'merge:todo']);
    assert.deepEqual(line.live, {after: 'checks', timing: {actual: 5 / 8, startedAt: NOW - 4 * MIN, expectedMs: RUN}});
    assert.equal(line.now, 'Checks running on the head · 5 of 8 done · merges in 4 min');
    assert.equal(station(line, 'review').sub, '@ben');
    assert.equal(station(line, 'landed').sub, clock(NOW - 50 * MIN));
    assert.equal(station(line, 'merged').sub, '~' + clock(NOW + 4 * MIN));
    // Landed 50 min ago, its checks started 4 min ago: 46 min in line.
    assert.equal(station(line, 'line').duration, '46 min');
    assert.equal(station(line, 'opened').sub, null);
});

test('the head being updated or merging: the step live by a queue step or a minute', () => {
    /* Given */
    const updating = rowAt({kind: 'head', step: 'updating'});
    const merging = rowAt(HEAD);

    /* When */
    const lines = [landedTimeline(updating, undefined, RUN, NOW), landedTimeline(merging, undefined, RUN, NOW)];

    /* Then */
    assert.deepEqual(parts(lines[0]!), ['update:now', 'checks:todo', 'merge:todo']);
    assert.deepEqual(lines[0]!.live, {
        after: 'update',
        timing: {actual: null, startedAt: null, expectedMs: QUEUE_STEP_MS},
    });
    assert.equal(lines[0]!.now, 'Being updated on the trunk at the head');
    assert.deepEqual(parts(lines[1]!), ['update:done', 'checks:done', 'merge:now']);
    assert.deepEqual(lines[1]!.live, {
        after: 'merge',
        timing: {actual: null, startedAt: null, expectedMs: MIN_ESTIMATE_MS},
    });
    assert.equal(lines[1]!.now, 'Merging now');
    assert.equal(station(lines[1]!, 'merged').sub, null);
    assert.equal(station(lines[1]!, 'line').duration, null);
});

test('a waiting PR: In line now with its place, how long it waited, and a rough merge time', () => {
    /* Given */
    const row = rowsOf([landedPr(1, 50, 'switchboard', HEAD), landedPr(2, 40)]).get(2)!;
    const at = NOW + 25 * MIN;
    const time: RowTime = {from: NOW + 14 * MIN, at, minutes: 25, rough: true};

    /* When */
    const line = landedTimeline(row, time, RUN, NOW);

    /* Then */
    assert.deepEqual(marks(line), ['done', 'done', 'done', 'done', 'now', 'todo', 'todo']);
    assert.equal(station(line, 'line').sub, '2nd');
    assert.equal(station(line, 'line').duration, '40 min');
    assert.equal(station(line, 'merged').sub, '≈' + clock(at));
    assert.equal(line.headParts, null);
    assert.equal(line.live, null);
    assert.equal(line.now, 'Waiting 2nd in its lane · merges in ~25 min');
});

test('a waiting PR a test rebase found a conflict in: In line conflict', () => {
    /* Given */
    const row = rowAt({kind: 'waiting', willConflict: true, position: null});

    /* When */
    const line = landedTimeline(row, undefined, RUN, NOW);

    /* Then */
    assert.equal(station(line, 'line').mark, 'conflict');
    assert.equal(line.now, 'Waiting 1st in its lane · it will conflict with the trunk');
});

test('held for a review: Review and In line held, the reviewer under Review, and it keeps its place', () => {
    /* Given */
    const row = rowAt({kind: 'held', reason: {kind: 'review', reviewer: 'ana', team: false}});

    /* When */
    const line = landedTimeline(row, undefined, RUN, NOW);

    /* Then */
    assert.deepEqual(marks(line), ['done', 'held', 'done', 'done', 'held', 'todo', 'todo']);
    assert.equal(station(line, 'review').sub, '@ana');
    assert.equal(line.now, 'Held until @ana reviews it · keeps its place');
    assert.equal(
        line.label,
        'Opened done, Review held, Checks done, Landed done, In line held, Head to come, Merged to come',
    );
    assert.equal(line.live, null);
});

test('held for an approval holds Review too; held on its base or as a draft only In line', () => {
    /* Given */
    const rows = rowsOf([
        landedPr(1, 50),
        landedPr(2, 40, 'switchboard', {kind: 'held', reason: {kind: 'base', base: 'branch-1'}}),
        landedPr(3, 30, 'switchboard', {kind: 'held', reason: {kind: 'draft'}}),
        landedPr(4, 20, 'switchboard', {kind: 'held', reason: {kind: 'approval'}}),
    ]);

    /* When */
    const [base, draft, approval] = [2, 3, 4].map((n) => landedTimeline(rows.get(n)!, undefined, RUN, NOW));

    /* Then */
    assert.deepEqual(marks(approval!), ['done', 'held', 'done', 'done', 'held', 'todo', 'todo']);
    assert.equal(station(approval!, 'review').sub, null);
    assert.deepEqual(marks(base!), ['done', 'done', 'done', 'done', 'held', 'todo', 'todo']);
    assert.equal(station(base!, 'line').sub, 'on #1');
    assert.equal(base!.now, 'Held until #1 merges · keeps its place');
    assert.deepEqual(marks(draft!), ['done', 'done', 'done', 'done', 'held', 'todo', 'todo']);
});

test('fixing: Head being fixed, on the step the errand mends', () => {
    /* Given */
    const conflict = rowAt({kind: 'fixing', cause: 'conflict'});
    const checks = rowAt({kind: 'fixing', cause: 'checks'});

    /* When */
    const lines = [conflict, checks].map((row) => landedTimeline(row, undefined, RUN, NOW));

    /* Then */
    assert.deepEqual(marks(lines[0]!), ['done', 'done', 'done', 'done', 'done', 'fixing', 'todo']);
    assert.deepEqual(parts(lines[0]!), ['update:fixing', 'checks:todo', 'merge:todo']);
    assert.deepEqual(parts(lines[1]!), ['update:done', 'checks:fixing', 'merge:todo']);
    assert.equal(lines[1]!.now, 'A fix errand mends its failed checks · keeps its place');
    assert.equal(lines[1]!.live, null);
    assert.match(lines[1]!.label, /Head being fixed/);
});

test('needs you for changes or a thread: Review stopped, still landed, its place kept in line', () => {
    /* Given */
    const rows = rowsOf([
        landedPr(1, 50, 'switchboard', HEAD),
        landedPr(2, 40, 'switchboard', {kind: 'needsYou', reason: {kind: 'changes-requested'}}),
        landedPr(3, 30, 'switchboard', {kind: 'needsYou', reason: {kind: 'unresolved-thread'}}),
    ]);

    /* When */
    const [changes, thread] = [2, 3].map((n) => landedTimeline(rows.get(n)!, undefined, RUN, NOW));

    /* Then */
    assert.deepEqual(marks(changes!), ['done', 'stopped', 'done', 'done', 'held', 'todo', 'todo']);
    assert.deepEqual(marks(thread!), ['done', 'stopped', 'done', 'done', 'held', 'todo', 'todo']);
    assert.equal(station(changes!, 'landed').sub, clock(NOW - 40 * MIN));
    assert.equal(station(changes!, 'line').sub, 'keeps 2nd');
    assert.equal(station(thread!, 'line').sub, 'keeps 3rd');
    assert.equal(changes!.headParts, null);
    assert.equal(changes!.now, 'Needs you: changes are requested');
    assert.equal(thread!.now, 'Needs you: a review thread is open');
});

test('needs you in a queue lane with no place known: In line held without a sub', () => {
    /* Given */
    const row = rowsOf([landedPr(1, 50, 'queue', {kind: 'needsYou', reason: {kind: 'changes-requested'}})]).get(1)!;

    /* When */
    const line = landedTimeline(row, undefined, RUN, NOW);

    /* Then */
    assert.equal(station(line, 'line').mark, 'held');
    assert.equal(station(line, 'line').sub, null);
});

test('needs you once an errand stopped or the merge was refused: Head stopped on the step it failed', () => {
    /* Given */
    const stopped = rowAt({kind: 'needsYou', reason: {kind: 'errand-stopped'}});
    const refused = rowAt({kind: 'needsYou', reason: {kind: 'merge-refused', reason: 'the base branch is protected'}});

    /* When */
    const lines = [stopped, refused].map((row) => landedTimeline(row, undefined, RUN, NOW));

    /* Then */
    assert.deepEqual(marks(lines[0]!), ['done', 'done', 'done', 'done', 'done', 'stopped', 'todo']);
    assert.deepEqual(parts(lines[0]!), ['update:done', 'checks:stopped', 'merge:todo']);
    assert.deepEqual(parts(lines[1]!), ['update:done', 'checks:done', 'merge:stopped']);
    assert.equal(lines[0]!.now, 'Needs you: the fix errand stopped without a fix');
    assert.equal(lines[1]!.now, 'Needs you: the base branch is protected');
});

// ── Not landed ──

test('a draft: Opened now, its review and checks as they stand, the rest to come', () => {
    /* Given */
    const pr = open({isDraft: true, reviewRequested: ['ana'], checks: 'pending'});

    /* When */
    const line = notLandedTimeline(pr, NOW);

    /* Then */
    assert.deepEqual(marks(line), ['now', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    assert.equal(station(line, 'opened').sub, clock(pr.createdAt));
    assert.equal(station(line, 'review').sub, '@ana');
    assert.equal(station(line, 'checks').sub, 'running');
    assert.equal(line.live, null);
    assert.equal(line.now, 'Draft');
    assert.equal(line.headParts, null);
});

test('waiting on review: Review to come, with who it is asked of or nobody asked, and green checks done', () => {
    /* Given */
    const asked = open({reviewRequested: ['ana', 'org/team']});
    const nobody = open({checks: null});

    /* When */
    const lines = [notLandedTimeline(asked, NOW), notLandedTimeline(nobody, NOW)];

    /* Then */
    assert.deepEqual(marks(lines[0]!), ['done', 'todo', 'done', 'todo', 'todo', 'todo', 'todo']);
    assert.equal(station(lines[0]!, 'review').sub, '@ana');
    assert.equal(station(lines[0]!, 'checks').sub, 'green');
    assert.equal(lines[0]!.now, 'Review asked of @ana, @org/team');
    assert.deepEqual(marks(lines[1]!), ['done', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    assert.equal(station(lines[1]!, 'review').sub, 'nobody asked');
    assert.equal(station(lines[1]!, 'checks').sub, null);
    assert.equal(lines[1]!.now, 'No review asked yet');
});

test('changes asked: Review stopped, by whom; checks still running are to come', () => {
    /* Given */
    const pr = open({reviewDecision: 'CHANGES_REQUESTED', changesRequestedBy: ['bram'], checks: 'pending'});

    /* When */
    const line = notLandedTimeline(pr, NOW);

    /* Then */
    assert.deepEqual(marks(line), ['done', 'stopped', 'todo', 'todo', 'todo', 'todo', 'todo']);
    assert.equal(station(line, 'review').sub, '@bram');
    assert.equal(station(line, 'checks').sub, 'running');
    assert.equal(line.live, null);
    assert.equal(line.now, 'Changes asked by @bram');
});

test('approved with its checks running: Checks now and live, without a time to go by', () => {
    /* Given */
    const pr = open({reviewDecision: 'APPROVED', approvedBy: ['ana'], checks: 'pending'});

    /* When */
    const line = notLandedTimeline(pr, NOW);

    /* Then */
    assert.deepEqual(marks(line), ['done', 'done', 'now', 'todo', 'todo', 'todo', 'todo']);
    assert.equal(station(line, 'review').sub, '@ana');
    assert.equal(station(line, 'checks').sub, 'running');
    assert.deepEqual(line.live, {after: 'checks', timing: {actual: null, startedAt: null, expectedMs: null}});
    assert.equal(line.now, 'Checks running · approved by @ana');
});

test('failing checks stop at Checks whatever the review; conflicts mark Landed', () => {
    /* Given */
    const failing = open({checks: 'failure'});
    const conflicting = open({mergeable: 'CONFLICTING', reviewDecision: 'APPROVED', approvedBy: ['ana']});

    /* When */
    const lines = [notLandedTimeline(failing, NOW), notLandedTimeline(conflicting, NOW)];

    /* Then */
    assert.deepEqual(marks(lines[0]!), ['done', 'todo', 'stopped', 'todo', 'todo', 'todo', 'todo']);
    assert.equal(station(lines[0]!, 'review').sub, 'nobody asked');
    assert.equal(station(lines[0]!, 'checks').sub, 'failing');
    assert.equal(lines[0]!.now, 'Its checks are failing');
    assert.deepEqual(marks(lines[1]!), ['done', 'done', 'done', 'conflict', 'todo', 'todo', 'todo']);
    assert.equal(lines[1]!.now, 'Conflicts with its base');
    assert.equal(lines[1]!.live, null);
});

test('a not landed PR never has more than one station now', () => {
    /* Given */
    const prs = [
        open({isDraft: true, reviewDecision: 'APPROVED', checks: 'pending'}),
        open({reviewDecision: 'APPROVED', checks: 'pending'}),
        open({reviewDecision: 'APPROVED'}),
        open({reviewRequested: ['ana'], checks: 'pending'}),
    ];

    /* When */
    const nows = prs.map((pr) => marks(notLandedTimeline(pr, NOW)).filter((mark) => mark === 'now').length);

    /* Then */
    assert.deepEqual(nows, [1, 1, 1, 0]);
});

test('approved and green: Landed now, the next move is Land it', () => {
    /* Given */
    const pr = open({reviewDecision: 'APPROVED', approvedBy: ['ana']});

    /* When */
    const line = notLandedTimeline(pr, NOW);

    /* Then */
    assert.deepEqual(marks(line), ['done', 'done', 'done', 'now', 'todo', 'todo', 'todo']);
    assert.equal(station(line, 'checks').sub, 'green');
    assert.equal(line.now, 'Approved and green · land it to join its lane');
    assert.equal(
        line.label,
        'Opened done, Review done, Checks done, Landed now, In line to come, Head to come, Merged to come',
    );
    assert.ok(line.stations.every((s) => s.duration === null));
});
