import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    failureKind,
    medianRunMs,
    mergeQueue,
    parseAutomergeStatus,
    queueEvents,
    usesMergeQueue,
    QUEUE_LABELS,
    type AutomergeStatus,
    type MergeQueueInput,
    type QueueCheckRun,
    type QueuePullRequest,
} from '../src/domain/project/merge-queue';

const MIN = 60_000;
const NOW = Date.parse('2026-11-04T14:00:00Z');
const RUNS = [20 * MIN, 22 * MIN, 24 * MIN]; // median 22 min

function pending(description: string): AutomergeStatus {
    return {state: 'pending', description};
}

function pr(number: number, fields: Partial<QueuePullRequest> = {}): QueuePullRequest {
    return {
        number,
        title: 'PR ' + number,
        url: 'https://github.com/o/r/pull/' + number,
        headRef: 'branch-' + number,
        baseRef: 'main',
        draft: false,
        labels: [],
        automerge: null,
        review: 'approved',
        requestedReviewers: [],
        approvedBy: ['reviewer'],
        checks: [],
        ...fields,
    };
}

function queued(number: number, position: number, fields: Partial<QueuePullRequest> = {}): QueuePullRequest {
    return pr(number, {
        labels: [QUEUE_LABELS.optIn],
        automerge: pending(`Number ${position} in the merge queue`),
        ...fields,
    });
}

function check(name: string, state: QueueCheckRun['state'], startedAt: number | null = null): QueueCheckRun {
    return {name, state, startedAt};
}

function input(pullRequests: QueuePullRequest[], fields: Partial<MergeQueueInput> = {}): MergeQueueInput {
    return {trunk: 'main', pullRequests, ciRunDurationsMs: RUNS, now: NOW, ...fields};
}

const HEAD = pr(1, {
    labels: [QUEUE_LABELS.optIn, QUEUE_LABELS.head],
    automerge: pending('First in the merge queue; merges once CI passes'),
    checks: [check('Lint', 'passed'), check('Tests', 'running', NOW - 10 * MIN)],
});

// ── Reading the queue's status ──

test('each of the queue status texts reads as its state', () => {
    /* Given */
    const cases: [AutomergeStatus, unknown][] = [
        [pending('First in the merge queue; merges once CI passes'), {kind: 'head', waitsForCiOn: null}],
        [pending('First in the merge queue; waits for CI on #12'), {kind: 'head', waitsForCiOn: 12}],
        [pending('Number 3 in the merge queue'), {kind: 'queued', position: 3}],
        [pending('Waits for an approval'), {kind: 'held', waitsFor: {kind: 'approval'}}],
        [pending('Waits for a review by @some-one'), {kind: 'held', waitsFor: {kind: 'review', reviewer: 'some-one'}}],
        [pending('A draft is not queued'), {kind: 'outside', why: {kind: 'draft'}}],
        [pending('Waits until `feature/a` merges'), {kind: 'outside', why: {kind: 'base', base: 'feature/a'}}],
        [pending('Waits until #9 is ready for review'), {kind: 'outside', why: {kind: 'stack-draft', member: 9}}],
        [
            {state: 'failure', description: 'CI failed'},
            {kind: 'failed', reason: 'CI failed'},
        ],
    ];

    for (const [status, expected] of cases) {
        /* When */
        const parsed = parseAutomergeStatus(status);

        /* Then */
        assert.deepEqual(parsed, {member: null, status: expected}, status.description);
    }
});

test('a status about another member of a stack names that member', () => {
    /* Given */
    const status = pending('#7: Waits for an approval');

    /* When */
    const parsed = parseAutomergeStatus(status);

    /* Then */
    assert.deepEqual(parsed, {member: 7, status: {kind: 'held', waitsFor: {kind: 'approval'}}});
});

test('a status the queue might add later keeps its own words', () => {
    /* Given */
    const status = pending('Resting until Monday');

    /* When */
    const parsed = parseAutomergeStatus(status);

    /* Then */
    assert.deepEqual(parsed.status, {kind: 'unknown', text: 'Resting until Monday'});
});

test('failure reasons are sorted into kinds', () => {
    /* Given / When / Then */
    assert.equal(failureKind('CI failed'), 'ci');
    assert.equal(failureKind('Conflicts with main'), 'conflict');
    assert.equal(failureKind('A review requests changes'), 'changes-requested');
    assert.equal(failureKind('An unresolved review thread'), 'unresolved-thread');
    assert.equal(failureKind('GitHub refused the merge'), 'merge-refused');
    assert.equal(failureKind('Something else'), 'other');
});

test('a reason is about CI only when it says so in whole words', () => {
    /* Given */
    const refused = 'GitHub refused the merge: insufficient permissions';
    const decision = 'The review decision on the latest commit is missing';
    const cancelled = 'A required check was cancelled';

    /* When */
    const kinds = [failureKind(refused), failureKind(decision), failureKind(cancelled)];

    /* Then */
    assert.deepEqual(kinds, ['merge-refused', 'other', 'ci']);
});

// ── Whether a repository uses it ──

test('a repository uses the queue when a PR carries a queue label or status', () => {
    /* Given */
    const plain = [pr(1), pr(2)];
    const labelled = [pr(1), pr(2, {labels: ['autorebase:opt-in']})];
    const statused = [pr(1, {automerge: pending('A draft is not queued')})];

    /* When / Then */
    assert.equal(usesMergeQueue(plain), false);
    assert.equal(usesMergeQueue(labelled), true);
    assert.equal(usesMergeQueue(statused), true);
});

// ── Order and places ──

test('the head and the numbered entries come in the queue order', () => {
    /* Given */
    const prs = [queued(3, 3), HEAD, queued(2, 2)];

    /* When */
    const queue = mergeQueue(input(prs));

    /* Then */
    assert.equal(queue.head?.number, 1);
    assert.deepEqual(
        queue.entries.map((entry) => [entry.number, entry.position]),
        [
            [2, 2],
            [3, 3],
        ],
    );
    assert.deepEqual(queue.counts, {queued: 3, held: 0, failed: 0});
});

test('a held entry comes after the numbered ones, says whom it waits for, and gets no estimate', () => {
    /* Given */
    const held = pr(4, {
        labels: [QUEUE_LABELS.optIn],
        automerge: pending('Waits for a review by @sam'),
        review: 'review_required',
        requestedReviewers: ['sam'],
    });

    /* When */
    const queue = mergeQueue(input([held, HEAD, queued(2, 2)]));

    /* Then */
    const last = queue.entries.at(-1)!;
    assert.equal(last.number, 4);
    assert.equal(last.position, 3);
    assert.deepEqual(last.state, {kind: 'held', waitsFor: {kind: 'review', reviewer: 'sam'}});
    assert.match(last.sentence, /until @sam reviews/);
    assert.equal(last.estimateMs, null);
    assert.equal(queue.counts.held, 1);
});

test('automerge:next shows on its entry', () => {
    /* Given */
    const next = queued(2, 2, {labels: [QUEUE_LABELS.next]});

    /* When */
    const queue = mergeQueue(input([HEAD, next]));

    /* Then */
    assert.equal(queue.entries[0].next, true);
});

// ── Stacks ──

test('a stack is one entry with its members bottom-up, and its members are not listed again', () => {
    /* Given */
    const bottom = pr(10, {headRef: 'a', baseRef: 'main', labels: [QUEUE_LABELS.withStack]});
    const middle = pr(11, {headRef: 'b', baseRef: 'a', labels: [QUEUE_LABELS.withStack]});
    const top = queued(12, 2, {headRef: 'c', baseRef: 'b'});

    /* When */
    const queue = mergeQueue(input([HEAD, top, middle, bottom]));

    /* Then */
    assert.equal(queue.entries.length, 1);
    const entry = queue.entries[0];
    assert.equal(entry.stack, true);
    assert.deepEqual(
        entry.members.map((member) => [member.number, member.labelled]),
        [
            [10, false],
            [11, false],
            [12, true],
        ],
    );
    assert.match(entry.sentence, /bottom-up.*#10 first/);
    assert.equal(queue.outside.length, 0);
});

test('a stack costs one run per member in the estimates behind it', () => {
    /* Given */
    const bottom = pr(10, {headRef: 'a', labels: [QUEUE_LABELS.withStack]});
    const top = queued(12, 2, {headRef: 'c', baseRef: 'a'});
    const after = queued(13, 3);

    /* When */
    const queue = mergeQueue(input([HEAD, top, bottom, after]));

    /* Then */
    const head = queue.head!.estimateMs!;
    assert.equal(queue.entries[0].estimateMs, head + 2 * 22 * MIN);
    assert.equal(queue.entries[1].estimateMs, head + 3 * 22 * MIN);
});

// ── The head ──

test("the head's stage counts its checks and names the running one", () => {
    /* Given / When */
    const queue = mergeQueue(input([HEAD]));

    /* Then */
    assert.deepEqual(queue.head?.stage, {kind: 'checks', done: 1, total: 2, running: 'Tests', waitsForCiOn: null});
    assert.equal(queue.head?.runningSince, NOW - 10 * MIN);
});

test('the head needs what is left of a median run, and at least a minute', () => {
    /* Given */
    const late = {...HEAD, checks: [check('Tests', 'running', NOW - 40 * MIN)]};

    /* When */
    const onTime = mergeQueue(input([HEAD]));
    const overstaying = mergeQueue(input([late]));

    /* Then */
    assert.equal(onTime.head?.estimateMs, 12 * MIN);
    assert.equal(overstaying.head?.estimateMs, MIN);
});

test('a head with every check green is merging, and one without checks is being rebased', () => {
    /* Given */
    const green = {...HEAD, checks: [check('Tests', 'passed')]};
    const bare = {...HEAD, checks: []};

    /* When / Then */
    assert.deepEqual(mergeQueue(input([green])).head?.stage, {kind: 'merging'});
    assert.deepEqual(mergeQueue(input([bare])).head?.stage, {kind: 'rebasing'});
});

test('the queue clears when its last queued entry merges', () => {
    /* Given */
    const prs = [HEAD, queued(2, 2), queued(3, 3)];

    /* When */
    const queue = mergeQueue(input(prs));

    /* Then */
    assert.equal(queue.clearsInMs, 12 * MIN + 2 * 22 * MIN);
});

test('with fewer than three green runs nothing is estimated', () => {
    /* Given */
    const prs = [HEAD, queued(2, 2)];

    /* When */
    const queue = mergeQueue(input(prs, {ciRunDurationsMs: [10 * MIN, 12 * MIN]}));

    /* Then */
    assert.equal(queue.runMs, null);
    assert.equal(queue.head?.estimateMs, null);
    assert.equal(queue.entries[0].estimateMs, null);
    assert.equal(queue.clearsInMs, null);
});

test('the median of an even number of runs is the mean of the middle two', () => {
    /* Given / When / Then */
    assert.equal(medianRunMs([30, 10, 20]), 20);
    assert.equal(medianRunMs([10, 20, 30, 40]), 25);
});

// ── Failed and outside ──

test('a failed entry is out of the queue with its reason, its failing check and when it rejoins', () => {
    /* Given */
    const broken = pr(5, {
        labels: [QUEUE_LABELS.optIn, QUEUE_LABELS.failed],
        automerge: {state: 'failure', description: 'CI failed'},
        checks: [check('Lint', 'passed'), check('Unit tests', 'failed')],
    });

    /* When */
    const queue = mergeQueue(input([HEAD, broken]));

    /* Then */
    assert.equal(queue.failed.length, 1);
    const failed = queue.failed[0];
    assert.equal(failed.kind, 'ci');
    assert.equal(failed.failingCheck, 'Unit tests');
    assert.match(failed.rejoins, /green re-run, or Retry/);
    assert.equal(queue.entries.length, 0);
    assert.equal(queue.counts.failed, 1);
});

test('drafts, PRs waiting on their base and approved PRs nobody queued wait outside', () => {
    /* Given */
    const draft = pr(20, {draft: true, labels: [QUEUE_LABELS.optIn], automerge: pending('A draft is not queued')});
    const based = pr(21, {baseRef: 'feature/x', automerge: pending('Waits until `feature/x` merges')});
    const approved = pr(22);
    const unapproved = pr(23, {review: 'review_required', approvedBy: []});

    /* When */
    const queue = mergeQueue(input([draft, based, approved, unapproved]));

    /* Then */
    assert.deepEqual(
        queue.outside.map((entry) => entry.text),
        ['#20 draft', '#21 waits until feature/x merges', '#22 approved, not queued'],
    );
});

test('an unknown status is listed with its own text', () => {
    /* Given */
    const odd = pr(30, {labels: [QUEUE_LABELS.optIn], automerge: pending('Resting until Monday')});

    /* When */
    const queue = mergeQueue(input([odd]));

    /* Then */
    assert.deepEqual(
        queue.unknown.map((entry) => [entry.number, entry.text]),
        [[30, 'Resting until Monday']],
    );
});

// ── Pills ──

test('every queued PR gets a pill, stack members included', () => {
    /* Given */
    const bottom = pr(10, {headRef: 'a', labels: [QUEUE_LABELS.withStack]});
    const top = queued(12, 2, {headRef: 'c', baseRef: 'a'});
    const broken = pr(5, {labels: [QUEUE_LABELS.failed], automerge: {state: 'failure', description: 'CI failed'}});
    const free = pr(6);
    const rebased = pr(7, {labels: [QUEUE_LABELS.rebaseOptIn], review: null, approvedBy: []});
    const conflicting = pr(8, {labels: [QUEUE_LABELS.nonRebaseable], review: null, approvedBy: []});

    /* When */
    const {pills} = mergeQueue(input([HEAD, top, bottom, broken, free, rebased, conflicting]));

    /* Then */
    assert.equal(pills[1].text, 'merging · 1st');
    assert.equal(pills[12].text, 'queued · 2nd');
    assert.equal(pills[10].text, 'queued · 2nd');
    assert.equal(pills[5].kind, 'failed');
    assert.equal(pills[6].text, '+ Queue');
    assert.equal(pills[7].text, 'kept rebased');
    assert.equal(pills[8].text, 'conflicts with main');
});

// ── Notifications ──

test('only my own PRs make events: up next, failed as the head, merged', () => {
    /* Given */
    const before = mergeQueue(input([HEAD, queued(2, 2), queued(3, 3)]));
    const second = pr(2, {
        labels: [QUEUE_LABELS.optIn, QUEUE_LABELS.head],
        automerge: pending('First in the merge queue; merges once CI passes'),
    });
    const afterMerge = mergeQueue(input([second, queued(3, 2)]));
    const failedHead = pr(1, {labels: [QUEUE_LABELS.failed], automerge: {state: 'failure', description: 'CI failed'}});
    const afterFail = mergeQueue(input([failedHead, second, queued(3, 2)]));

    /* When */
    const merged = queueEvents(before, afterMerge, new Set([1, 2]), new Set([1]));
    const failed = queueEvents(before, afterFail, new Set([1]), new Set());
    const notMine = queueEvents(before, afterMerge, new Set([3]), new Set([1]));

    /* Then */
    assert.deepEqual(
        merged.map((event) => [event.kind, event.number]),
        [
            ['merged', 1],
            ['head', 2],
        ],
    );
    assert.deepEqual(
        failed.map((event) => [event.kind, event.number]),
        [['failed', 1]],
    );
    assert.deepEqual(notMine, []);
});
