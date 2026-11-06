/**
 * The CI job queue under the merge queue: runner pools, the FIFO runner
 * wait over runner slots, typical run times, and which runs a Bump moves.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    bumpConfirm,
    bumpedRuns,
    ciJobQueue,
    expectedWaitMs,
    runnerPools,
    typicalJobTimes,
    TIMED_RUNS_PER_WORKFLOW,
    type CiJob,
    type JobPool,
    type JobQueueInput,
    type JobRow,
    type Runner,
    type TimedRun,
} from '../src/domain/project/ci-job-queue';

const MIN = 60_000;
const NOW = Date.parse('2026-11-06T10:00:00Z');
const MAC = ['self-hosted', 'macOS', 'ARM64'];

function runner(name: string, fields: Partial<Runner> = {}): Runner {
    return {name, labels: MAC, busy: false, online: true, ...fields};
}

function job(id: number, fields: Partial<CiJob> = {}): CiJob {
    return {
        id,
        runId: id * 10,
        url: `https://github.com/o/r/actions/runs/${id * 10}/job/${id}`,
        workflow: 'CI',
        workflowId: 1,
        name: 'Tests',
        status: 'queued',
        createdAt: NOW - id * MIN,
        startedAt: null,
        runner: null,
        labels: MAC,
        on: {kind: 'pr', number: 100 + id, title: 'PR ' + (100 + id)},
        actor: 'ana',
        ...fields,
    };
}

function running(id: number, on: string, startedMinutesAgo: number, fields: Partial<CiJob> = {}): CiJob {
    return job(id, {
        status: 'running',
        runner: on,
        startedAt: NOW - startedMinutesAgo * MIN,
        createdAt: NOW - (startedMinutesAgo + 1) * MIN,
        ...fields,
    });
}

/** Every job of workflow 1 typically runs 10 minutes. */
const TEN_MINUTES: JobQueueInput['typical'] = () => 10 * MIN;

function input(fields: Partial<JobQueueInput>): JobQueueInput {
    return {jobs: [], runners: [], typical: TEN_MINUTES, otherSince: () => null, now: NOW, ...fields};
}

function jobRows(pool: JobPool): JobRow[] {
    return pool.rows.filter((row): row is JobRow => row.kind === 'job');
}

// ── Runner pools ──

test('runners whose labels hold one another make one pool, named by the labels they share', () => {
    /* Given */
    const runners = [
        runner('mini', {labels: ['self-hosted', 'macOS', 'ARM64']}),
        runner('mbp', {labels: ['self-hosted', 'macOS', 'ARM64', 'xcode-16']}),
        runner('linux-1', {labels: ['self-hosted', 'Linux']}),
        runner('offline', {online: false}),
    ];

    /* When */
    const pools = runnerPools(runners);

    /* Then */
    assert.deepEqual(
        pools.map((pool) => [pool.name, pool.runners.map((r) => r.name)]),
        [
            ['macOS · ARM64', ['mini', 'mbp']],
            ['Linux', ['linux-1']],
        ],
    );
});

// ── The runner wait ──

test('queued jobs take the slot that frees first, first come first served, each slot free after its typical run time', () => {
    /* Given */
    const jobs = [
        running(1, 'mini', 6), // frees in 4 min
        running(2, 'mbp', 2), // frees in 8 min
        job(3, {createdAt: NOW - 5 * MIN}), // oldest queued: takes mini at +4
        job(4, {createdAt: NOW - 3 * MIN}), // takes mbp at +8
        job(5, {createdAt: NOW - 1 * MIN}), // takes mini again at +14
    ];

    /* When */
    const [pool] = ciJobQueue(input({jobs, runners: [runner('mini'), runner('mbp')]}));

    /* Then */
    const queued = jobRows(pool).filter((row) => row.job.status === 'queued');
    assert.deepEqual(
        queued.map((row) => [row.job.id, expectedWaitMs(row, NOW)! / MIN, (row.endsAt! - NOW) / MIN]),
        [
            [3, 4, 14],
            [4, 8, 18],
            [5, 14, 24],
        ],
    );
});

test('a pool lists its running jobs first, then its queued ones in turn, and says which runners are busy', () => {
    /* Given */
    const jobs = [job(4, {createdAt: NOW - MIN}), running(1, 'mini', 3), job(3, {createdAt: NOW - 2 * MIN})];

    /* When */
    const [pool] = ciJobQueue(input({jobs, runners: [runner('mini'), runner('mbp')]}));

    /* Then */
    assert.deepEqual(
        jobRows(pool).map((row) => row.job.id),
        [1, 3, 4],
    );
    assert.deepEqual(pool.runners, [
        {name: 'mini', busy: true},
        {name: 'mbp', busy: false},
    ]);
});

test('a job past its typical time ends any moment, so what waits behind it is a lower bound', () => {
    /* Given */
    const jobs = [running(1, 'mini', 25), job(2)];

    /* When */
    const [pool] = ciJobQueue(input({jobs, runners: [runner('mini')]}));

    /* Then */
    const [late, waiting] = jobRows(pool);
    assert.equal(late.endsAt, NOW);
    assert.equal(late.lowerBound, true);
    assert.equal(expectedWaitMs(waiting, NOW), 0);
    assert.equal(waiting.lowerBound, true);
});

test('a runner busy with another repository’s job frees a typical job of its pool after it was first seen busy', () => {
    /* Given */
    const jobs = [running(1, 'mini', 2), job(2)];
    const runners = [runner('mini'), runner('shared', {busy: true})];

    /* When */
    const [pool] = ciJobQueue(input({jobs, runners, otherSince: () => NOW - 7 * MIN}));

    /* Then */
    const other = pool.rows.find((row) => row.kind === 'other');
    assert.deepEqual(other, {kind: 'other', runner: 'shared', endsAt: NOW + 3 * MIN, lowerBound: false});
    const waiting = jobRows(pool).find((row) => row.job.id === 2)!;
    assert.equal(expectedWaitMs(waiting, NOW), 3 * MIN);
});

test('behind a job with no typical time nobody can tell when a slot frees', () => {
    /* Given */
    const jobs = [running(1, 'mini', 2, {name: 'New job'}), job(2)];
    const typical: JobQueueInput['typical'] = (_, name) => (name === 'Tests' ? 10 * MIN : null);

    /* When */
    const [pool] = ciJobQueue(input({jobs, runners: [runner('mini')], typical}));

    /* Then */
    const waiting = jobRows(pool).find((row) => row.job.id === 2)!;
    assert.equal(waiting.startsAt, null);
    assert.equal(expectedWaitMs(waiting, NOW), null);
});

test('jobs no online runner fits get a pool of their own, named by their labels; GitHub-hosted jobs are left out', () => {
    /* Given */
    const jobs = [job(1, {labels: ['self-hosted', 'Windows']}), job(2, {labels: ['ubuntu-latest']})];

    /* When */
    const pools = ciJobQueue(input({jobs, runners: [runner('mini')]}));

    /* Then */
    assert.deepEqual(
        pools.map((pool) => [pool.name, pool.runners.length, pool.rows.length]),
        [
            ['macOS · ARM64', 1, 0],
            ['Windows', 0, 1],
        ],
    );
});

// ── Typical run times ──

test('a job’s typical run time is its median over its workflow’s newest 20 timed runs', () => {
    /* Given */
    const newest: TimedRun[] = [3, 5, 7].map((minutes, index) => ({
        runId: index + 1,
        workflowId: 1,
        jobs: {Tests: minutes * MIN},
    }));
    const older: TimedRun[] = Array.from({length: TIMED_RUNS_PER_WORKFLOW}, (_, index) => ({
        runId: 100 + index,
        workflowId: 1,
        jobs: {Tests: 60 * MIN},
    }));
    const other: TimedRun = {runId: 999, workflowId: 2, jobs: {Tests: 1 * MIN}};

    /* When */
    const typical = typicalJobTimes([...newest, other, ...older]);

    /* Then */
    assert.equal(typical(1, 'Tests'), 60 * MIN); // 3 newest at 3, 5, 7 and 17 more at 60
    assert.equal(typical(2, 'Tests'), MIN);
    assert.equal(typical(1, 'Lint'), null);
    assert.equal(typicalJobTimes(newest)(1, 'Tests'), 5 * MIN);
});

// ── Bump ──

function pools(jobs: CiJob[]): JobPool[] {
    return ciJobQueue(input({jobs, runners: [runner('mini')]}));
}

test('a bump moves the runs of the queued jobs ahead of it in its pool, once per run', () => {
    /* Given */
    const jobs = [
        running(1, 'mini', 2),
        job(2, {createdAt: NOW - 9 * MIN}),
        job(3, {createdAt: NOW - 8 * MIN, runId: 20, name: 'Lint'}), // same run as job 2
        job(4, {createdAt: NOW - 7 * MIN}),
        job(5, {createdAt: NOW - 6 * MIN}), // the one bumped
        job(6, {createdAt: NOW - 5 * MIN}), // behind it: untouched
    ];

    /* When */
    const runs = bumpedRuns(pools(jobs), 5, []);

    /* Then */
    assert.deepEqual(
        runs.map((run) => run.runId),
        [20, 40],
    );
});

test('a bump leaves alone a run with a job running, its own run, the queue’s passes and the head’s CI', () => {
    /* Given */
    const jobs = [
        running(1, 'mini', 2),
        job(2, {createdAt: NOW - 9 * MIN, runId: 10}), // its run has job 1 running
        job(3, {createdAt: NOW - 8 * MIN, workflow: 'Merge queue'}),
        job(4, {createdAt: NOW - 7 * MIN, on: {kind: 'pr', number: 7, title: 'Head'}}),
        job(5, {createdAt: NOW - 6 * MIN, runId: 60}), // the bumped job's own run
        job(6, {createdAt: NOW - 5 * MIN}), // the one bumped
    ];

    /* When */
    const runs = bumpedRuns(pools(jobs), 6, [7]);

    /* Then */
    assert.deepEqual(runs, []);
});

test('only a queued job can be bumped', () => {
    /* Given */
    const jobs = [running(1, 'mini', 2), job(2)];

    /* When */
    const runs = bumpedRuns(pools(jobs), 1, []);

    /* Then */
    assert.deepEqual(runs, []);
});

test('the bump’s confirm names every run it moves and whose it is', () => {
    /* Given */
    const target = job(5, {name: 'Build', on: {kind: 'pr', number: 12, title: 'Mine'}});
    const runs = [job(2, {actor: 'sam'}), job(3, {on: {kind: 'branch', branch: 'main'}, actor: null})];

    /* When */
    const text = bumpConfirm(target, runs);

    /* Then */
    assert.match(text, /^Bump Build on #12 Mine\?/);
    assert.match(text, /cancels and re-runs 2 runs so they queue behind it/);
    assert.match(text, /• CI on #102 PR 102 \(sam\)/);
    assert.match(text, /• CI on main\n/);
    assert.match(text, /does not promise to hand out runners in order/);
});
