/**
 * The same stage words everywhere (#441): the shared table, and what the
 * sidebar's pill, the plan cards' `planQueuePill`, the Issue manager's In
 * progress pill and the project page's Switchboard lane make of it, in both
 * lanes. PRs that are not landed keep each place's own words.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    findLanded,
    inProgressPill,
    landedForItem,
    landedWords,
    needsYouInProgress,
    stageWords,
} from '../src/domain/merge-manager/stage-words';
import {sessionQueueMark} from '../src/domain/project/queue-elsewhere';
import {planQueuePill} from '../src/renderer/ui/session-work/plan/describe';
import {laneCountsText, laneEstimates, laneHeadSteps, laneRows} from '../src/renderer/ui/project-page/merge-queue-view';
import {landedKey} from '../src/domain/merge-manager/model';
import type {LandedView, LaneStage, LaneView, MergeManagerState} from '../src/domain/merge-manager/model';
import type {InboxItem, InboxStage} from '../src/domain/inbox/model';
import {issue as planIssue, pr as planPr} from './support/plans';
import {bug as inboxBug, issue as inboxIssue} from './support/inbox-fixtures';
import {queueOf, queued} from './support/merge-queue-fixtures';
import {HEAD, landedPr, MIN, REPO} from './support/merge-manager-fixtures';

const WAITING: LaneStage = {kind: 'waiting', willConflict: false, position: null};

function landed(number: number, stage: LaneStage, place: number | null, repository = REPO): LandedView {
    return {
        ...landedPr(number, 60 - number, 'switchboard', stage),
        key: landedKey(repository, number),
        repository,
        place,
    };
}

function lane(pullRequests: LandedView[], kind: LaneView['kind'] = 'switchboard', repository = REPO): LaneView {
    return {repository, kind, approvalLostOnPush: false, pullRequests};
}

function state(...lanes: LaneView[]): MergeManagerState {
    return {lanes, needsYou: 0};
}

// ── The table ──

test('each stage has one set of words: a pill, a label and a tooltip', () => {
    /* Given */
    const stages: [LaneStage, number | null][] = [
        [WAITING, 2],
        [{kind: 'waiting', willConflict: false, position: 4}, 2],
        [{kind: 'held', reason: {kind: 'review', reviewer: 'ana', team: false}}, null],
        [{kind: 'held', reason: {kind: 'approval'}}, null],
        [{kind: 'held', reason: {kind: 'base', base: 'feature-base'}}, null],
        [{kind: 'held', reason: {kind: 'draft'}}, null],
        [{kind: 'head', step: 'checks'}, 1],
        [{kind: 'fixing', cause: 'conflict'}, null],
        [{kind: 'needsYou', reason: {kind: 'changes-requested'}}, null],
        [{kind: 'merged', at: 0}, null],
    ];

    /* When */
    const words = stages.map(([stage, place]) => stageWords(stage, place));

    /* Then */
    assert.deepEqual(
        words.map((said) => [said.kind, said.pill, said.label]),
        [
            ['waiting', 'landed · 2nd', 'Landed · 2nd'],
            ['waiting', 'landed · 4th', 'Landed · 4th'],
            ['held', 'held · @ana', 'Held · @ana'],
            ['held', 'held · approval', 'Held · approval'],
            ['held', 'held · on feature-base', 'Held · on feature-base'],
            ['held', 'held · draft', 'Held · draft'],
            ['head', 'merging', 'Merging'],
            ['fixing', 'fixing', 'Fixing'],
            ['needsYou', 'needs you', 'Needs you'],
            ['merged', 'merged', 'Merged'],
        ],
    );
    assert.equal(words[6].title, 'The head: its checks are running');
    assert.equal(words[8].title, 'Needs you: changes are requested');
});

test('a waiting PR a test rebase found a conflict in is flagged "will conflict"', () => {
    /* Given */
    const stage: LaneStage = {kind: 'waiting', willConflict: true, position: null};

    /* When */
    const words = stageWords(stage, 3);

    /* Then */
    assert.equal(words.pill, 'landed · 3rd');
    assert.equal(words.flag, 'will conflict');
    assert.match(words.title, /will conflict/);
});

test('a PR stacked on a landed PR is held "on #n"', () => {
    /* Given */
    const base = landed(433, WAITING, 2);
    const stacked = landed(434, {kind: 'held', reason: {kind: 'base', base: base.headRef}}, null);
    const merge = state(lane([base, stacked]));

    /* When */
    const words = landedWords(findLanded(merge, REPO, 434)!);

    /* Then */
    assert.equal(words.pill, 'held · on #433');
});

test('a landed PR is found by its repository whatever its case; any other is not landed', () => {
    /* Given */
    const merge = state(lane([landed(12, HEAD, 1)]));

    /* When */
    const found = findLanded(merge, REPO.toUpperCase(), 12);
    const other = findLanded(merge, REPO, 13);

    /* Then */
    assert.equal(found?.pullRequest.number, 12);
    assert.equal(other, null);
});

// ── The sidebar ──

test('a session row with a landed PR shows its stage; one in the queue but not landed keeps the queue’s words', () => {
    /* Given */
    const queueRepo = 'o/app';
    const queues = {[queueRepo]: queueOf([queued(2, 2), queued(3, 3)])};
    const merge = state(
        lane([landed(2, {kind: 'waiting', willConflict: true, position: 2}, 2, queueRepo)], 'queue', queueRepo),
        lane([landed(7, {kind: 'fixing', cause: 'checks'}, null)]),
    );
    const link = (number: number, repository: string) => ({
        number,
        url: `https://github.com/${repository}/pull/${number}`,
        repository,
    });

    /* When */
    const landedQueue = sessionQueueMark('a', [link(2, queueRepo)], queues, {}, merge).pill;
    const notLanded = sessionQueueMark('b', [link(3, queueRepo)], queues, {}, merge).pill;
    const switchboard = sessionQueueMark('c', [link(7, REPO)], queues, {}, merge).pill;
    const nothing = sessionQueueMark('d', [link(8, REPO)], queues, {}, merge).pill;

    /* Then */
    assert.deepEqual(
        [landedQueue?.kind, landedQueue?.text, landedQueue?.flag],
        ['landed-waiting', 'landed · 2nd', 'will conflict'],
    );
    assert.deepEqual([notLanded?.kind, notLanded?.text], ['queued', '3rd']);
    assert.deepEqual([switchboard?.kind, switchboard?.text], ['landed-fixing', 'fixing']);
    assert.equal(nothing, null);
});

// ── Plan cards ──

test('planQueuePill says a landed PR’s stage in a Switchboard lane, which has no queue labels', () => {
    /* Given */
    const card = planIssue(10, {pullRequests: [planPr(111, 'open')]});
    const repository = card.repository;
    const merge = (stage: LaneStage, place: number | null) => state(lane([landed(111, stage, place, repository)]));

    /* When */
    const pills = [
        planQueuePill(card, merge({kind: 'waiting', willConflict: true, position: null}, 2)),
        planQueuePill(card, merge({kind: 'held', reason: {kind: 'review', reviewer: 'sam', team: false}}, null)),
        planQueuePill(card, merge(HEAD, 1)),
        planQueuePill(card, merge({kind: 'needsYou', reason: {kind: 'unresolved-thread'}}, null)),
        planQueuePill(card),
    ];

    /* Then */
    assert.deepEqual(
        pills.map((pill) => (pill ? [pill.kind, pill.text] : null)),
        [
            ['landed-waiting', 'landed · 2nd · will conflict'],
            ['landed-held', 'held · @sam'],
            ['landed-head', 'merging'],
            ['landed-needsYou', 'needs you'],
            null,
        ],
    );
});

test('planQueuePill says a landed PR’s stage in a queue lane; a teammate’s queued PR keeps the queue’s words', () => {
    /* Given */
    const queuedPr = {
        ...planPr(111, 'open'),
        queue: {automerge: {state: 'pending' as const, description: 'Number 3 in the merge queue'}},
    };
    const mine = planIssue(10, {pullRequests: [queuedPr]});
    const theirs = planIssue(11, {pullRequests: [{...queuedPr, number: 112}]});
    const merge = state(
        lane(
            [landed(111, {kind: 'waiting', willConflict: false, position: 3}, 3, mine.repository)],
            'queue',
            mine.repository,
        ),
    );

    /* When */
    const pills = [planQueuePill(mine, merge), planQueuePill(theirs, merge)];

    /* Then */
    assert.deepEqual(
        pills.map((pill) => [pill?.kind, pill?.text]),
        [
            ['landed-waiting', 'landed · 3rd'],
            ['queued', 'queued · 3rd'],
        ],
    );
});

// ── In progress ──

function inProgress(number: number, stage: InboxStage, pullRequest: number | null): InboxItem {
    const facts = inboxIssue(number);
    return {
        key: `issue:${facts.repository}#${number}`,
        manager: 'issue',
        source: facts.repository,
        createdAt: 0,
        state: {kind: 'inProgress', stage},
        facts,
        signals: null,
        notes: '',
        work: {branch: 'b', sessionId: null, pullRequest},
    };
}

test('In progress shows a landed PR’s stage, and its own stage before it is landed', () => {
    /* Given */
    const merge = state(lane([landed(51, {kind: 'held', reason: {kind: 'approval'}}, null)]));
    const landedItem = inProgress(5, 'ready', 51);
    const notLanded = inProgress(6, 'prCi', 61);

    /* When */
    const pills = [
        inProgressPill('ready', landedForItem(merge, landedItem)),
        inProgressPill('prCi', landedForItem(merge, notLanded)),
    ];

    /* Then */
    assert.deepEqual(
        pills.map((pill) => [pill.kind, pill.label]),
        [
            ['landed-held', 'Held · approval'],
            ['prCi', 'PR · CI'],
        ],
    );
});

test('the In progress tab gets its peach dot while a landed PR there needs you', () => {
    /* Given */
    const calm = state(lane([landed(51, HEAD, 1)]));
    const needsYou = state(lane([landed(51, {kind: 'needsYou', reason: {kind: 'errand-stopped'}}, null)]));
    const items = [inProgress(5, 'queue', 51)];

    /* When */
    const dots = [needsYouInProgress(items, calm), needsYouInProgress(items, needsYou)];

    /* Then */
    assert.deepEqual(dots, [false, true]);
});

// ── The project page's Switchboard lane ──

test('a Switchboard lane’s section lists the head, then the waiting ones, then the rest; merged ones are left out', () => {
    /* Given */
    const shown = lane([
        landed(3, {kind: 'held', reason: {kind: 'approval'}}, null),
        landed(2, WAITING, 2),
        landed(1, HEAD, 1),
        landed(4, {kind: 'merged', at: 0}, null),
        landed(5, {kind: 'needsYou', reason: {kind: 'changes-requested'}}, null),
    ]);

    /* When */
    const rows = laneRows(shown);

    /* Then */
    assert.deepEqual(
        rows.map((pr) => pr.number),
        [1, 2, 3, 5],
    );
    assert.equal(laneCountsText(rows), '1 head · 1 waiting · 1 held · 1 needs you');
});

test('a Switchboard lane’s estimates: what is left of the head, then one run and a step for each PR behind it', () => {
    /* Given */
    const rows = [landed(1, {kind: 'head', step: 'checks'}, 1), landed(2, WAITING, 2), landed(3, WAITING, 3)];

    /* When */
    const estimates = laneEstimates(rows, 10 * MIN);
    const none = laneEstimates(rows, null);

    /* Then */
    assert.deepEqual(
        [...estimates.entries()],
        [
            [1, 5 * MIN],
            [2, 16 * MIN],
            [3, 27 * MIN],
        ],
    );
    assert.equal(none.size, 0);
});

test('a Switchboard lane’s head goes Updated on the trunk → Checks → Merge', () => {
    /* When */
    const steps = laneHeadSteps('checks');

    /* Then */
    assert.deepEqual(
        steps.map((step) => [step.label, step.state]),
        [
            ['Updated on the trunk', 'done'],
            ['Checks', 'active'],
            ['Merge', 'todo'],
        ],
    );
});

test("a bug's Fix PR, once landed, says its stage in the same words; before, Queue names its place", () => {
    /* Given */
    const merge = state(lane([landed(51, {kind: 'needsYou', reason: {kind: 'changes-requested'}}, null)]));
    const facts = inboxBug('err-1');
    const fixed = (pr: number | null): InboxItem =>
        ({
            key: 'bug:err-1',
            manager: 'bug',
            source: 'connect',
            createdAt: 0,
            state: {kind: 'inProgress', stage: 'queue'},
            facts,
            signals: null,
            notes: '',
            fix: {
                projectPath: '/code/connect',
                repository: REPO,
                branch: 'fix/err-1',
                worktree: '/code/connect/.claude/worktrees/fix',
                sessionId: null,
                startedAt: 0,
                pr: pr === null ? null : {number: pr, url: ''},
                queuePosition: 2,
                checks: null,
                sessionEnded: false,
            },
        }) as InboxItem;

    /* When */
    const pills = [
        inProgressPill('queue', landedForItem(merge, fixed(51)), 2),
        inProgressPill('queue', landedForItem(merge, fixed(52)), 2),
    ];

    /* Then */
    assert.deepEqual(
        pills.map((pill) => [pill.kind, pill.label]),
        [
            ['landed-needsYou', 'Needs you'],
            ['queue', 'Queue · 2nd'],
        ],
    );
    assert.equal(needsYouInProgress([fixed(51)], merge), true);
});
