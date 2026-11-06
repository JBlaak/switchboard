/**
 * The CI job queue service against a fake GitHub: its reads (cached, timed
 * runs kept) and the Bump sequence — cancel the runs ahead, wait until GitHub
 * says each stopped, then re-run their failed and cancelled jobs.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {BUMP_LOOK_MS, BUMP_WAIT_MS, CiJobQueueService} from '../src/application/services/ci-job-queue-service';
import type {CiJob, CiJobQueueAnswer, Runner, TimedRun} from '../src/domain/project/ci-job-queue';
import type {CiJobQueueCalls, GitHubCli, GitHubWrite} from '../src/application/ports/github-cli';
import {fakeTimers, silentLog} from './support/fakes';

const REPO = 'acme/app';
const MIN = 60_000;
const START = Date.parse('2026-11-06T10:00:00Z');
const MAC = ['self-hosted', 'macOS'];

function job(id: number, fields: Partial<CiJob> = {}): CiJob {
    return {
        id,
        runId: id * 10,
        url: '',
        workflow: 'CI',
        workflowId: 1,
        name: 'Tests',
        status: 'queued',
        createdAt: START - (10 - id) * MIN,
        startedAt: null,
        runner: null,
        labels: MAC,
        on: {kind: 'pr', number: 100 + id, title: 'PR ' + (100 + id)},
        actor: 'sam',
        ...fields,
    };
}

interface FakeGitHub extends Pick<GitHubCli, CiJobQueueCalls> {
    jobs: CiJob[];
    runners: Runner[];
    /** Runs GitHub says have stopped. */
    stopped: Set<number>;
    cancelAnswers: Map<number, GitHubWrite>;
    rerunAnswer: GitHubWrite;
    calls: string[];
}

function fakeGitHub(): FakeGitHub {
    const fake: FakeGitHub = {
        jobs: [],
        runners: [{name: 'mini', labels: MAC, busy: true, online: true}],
        stopped: new Set(),
        cancelAnswers: new Map(),
        rerunAnswer: {ok: true},
        calls: [],
        async selfHostedRunners() {
            fake.calls.push('runners');
            return fake.runners;
        },
        async ciJobs() {
            fake.calls.push('jobs');
            return fake.jobs;
        },
        async successfulRuns(_repo, workflowId) {
            fake.calls.push('runs ' + workflowId);
            return [7, 8, 9];
        },
        async runJobTimes(_repo, runId, workflowId): Promise<TimedRun> {
            fake.calls.push('times ' + runId);
            return {runId, workflowId, jobs: {Tests: 10 * MIN}};
        },
        async runCompleted(_repo, runId) {
            fake.calls.push('stopped? ' + runId);
            return fake.stopped.has(runId);
        },
        async cancelRun(_repo, runId) {
            fake.calls.push('cancel ' + runId);
            return fake.cancelAnswers.get(runId) ?? {ok: true};
        },
        async rerunFailedJobs(_repo, runId) {
            fake.calls.push('rerun ' + runId);
            return fake.rerunAnswer;
        },
    };
    return fake;
}

function setUp() {
    const github = fakeGitHub();
    const timers = fakeTimers();
    let now = START;
    const service = new CiJobQueueService({github, timers, clock: {now: () => now}, log: silentLog});
    return {
        github,
        timers,
        service,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

/** Let the promises a timer started settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function ok(answer: CiJobQueueAnswer): Extract<CiJobQueueAnswer, {ok: true}> {
    assert.ok(answer.ok, 'expected an answer');
    return answer;
}

/** Job 1 runs on mini; 2 and 3 (another run each) queue, then 4. */
function busyRunner(github: FakeGitHub): void {
    github.jobs = [job(1, {status: 'running', runner: 'mini', startedAt: START - 2 * MIN}), job(2), job(3), job(4)];
}

// ── Reads ──

test('a read answers the jobs by runner pool, with each queued one’s expected runner wait', async () => {
    /* Given */
    const {github, service} = setUp();
    busyRunner(github);

    /* When */
    const answer = ok(await service.read(REPO));

    /* Then */
    assert.equal(answer.pools.length, 1);
    const starts = answer.pools[0].rows.map((row) => (row.kind === 'job' ? row.startsAt : null));
    assert.deepEqual(starts, [START - 2 * MIN, START + 8 * MIN, START + 18 * MIN, START + 28 * MIN]);
});

test('a second read within 30 s asks GitHub nothing, and a timed run is never read twice', async () => {
    /* Given */
    const {github, service, advance} = setUp();
    busyRunner(github);
    await service.read(REPO);
    const first = github.calls.filter((call) => call.startsWith('times')).length;

    /* When */
    github.calls = [];
    advance(20_000);
    await service.read(REPO);
    const cached = [...github.calls];
    advance(20_000);
    await service.read(REPO);

    /* Then */
    assert.equal(first, 3);
    assert.deepEqual(cached, []);
    assert.deepEqual(
        github.calls.filter((call) => call.startsWith('times')),
        [],
    );
    assert.ok(github.calls.includes('jobs'));
});

test('a read GitHub does not answer says so', async () => {
    /* Given */
    const {github, service} = setUp();
    github.ciJobs = async () => null;

    /* When */
    const answer = await service.read(REPO);

    /* Then */
    assert.equal(answer.ok, false);
});

// ── Bump ──

test('a bump cancels the runs ahead, then re-runs each once GitHub says it stopped', async () => {
    /* Given */
    const {github, service, timers} = setUp();
    busyRunner(github);

    /* When */
    const result = await service.bump({repository: REPO, jobId: 4, runIds: [20, 30], headNumbers: []});

    /* Then */
    assert.deepEqual(result, {ok: true, runs: 2});
    assert.deepEqual(
        github.calls.filter((call) => call.startsWith('cancel')),
        ['cancel 20', 'cancel 30'],
    );
    assert.equal(timers.pending, 2);

    /* When */
    github.calls = [];
    github.stopped.add(20);
    timers.tick();
    await settle();

    /* Then */
    assert.deepEqual(github.calls, ['stopped? 20', 'stopped? 30', 'rerun 20']);
    assert.equal(timers.pending, 1, 'run 30 is looked at again');

    /* When */
    github.calls = [];
    github.stopped.add(30);
    timers.tick();
    await settle();

    /* Then */
    assert.deepEqual(github.calls, ['stopped? 30', 'rerun 30']);
    assert.equal(timers.pending, 0);
});

test('a bump touches only the runs its confirm named', async () => {
    /* Given */
    const {github, service} = setUp();
    busyRunner(github);

    /* When */
    const result = await service.bump({repository: REPO, jobId: 4, runIds: [30], headNumbers: []});

    /* Then */
    assert.deepEqual(result, {ok: true, runs: 1});
    assert.deepEqual(
        github.calls.filter((call) => call.startsWith('cancel')),
        ['cancel 30'],
    );
});

test('a bump never cancels the queue head’s CI', async () => {
    /* Given */
    const {github, service} = setUp();
    busyRunner(github);

    /* When */
    const result = await service.bump({repository: REPO, jobId: 4, runIds: [20, 30], headNumbers: [102, 103]});

    /* Then */
    assert.equal(result.ok, false);
    assert.ok(!github.calls.some((call) => call.startsWith('cancel')));
});

test('a cancel GitHub refuses stops the bump, still re-runs what it cancelled, and shows on the bumped job', async () => {
    /* Given */
    const {github, service, timers} = setUp();
    busyRunner(github);
    github.cancelAnswers.set(30, {ok: false, reason: 'Must have admin rights'});

    /* When */
    const result = await service.bump({repository: REPO, jobId: 4, runIds: [20, 30], headNumbers: []});
    github.stopped.add(20);
    timers.tick();
    await settle();

    /* Then */
    assert.deepEqual(result, {ok: false, reason: 'Cancelling CI on #103 PR 103: Must have admin rights'});
    assert.ok(github.calls.includes('rerun 20'));
    assert.match(ok(await service.read(REPO)).notes[4], /Must have admin rights/);
});

test('a run that does not stop within 2 minutes is not run again, and the bumped job says so', async () => {
    /* Given */
    const {github, service, timers, advance} = setUp();
    busyRunner(github);
    await service.bump({repository: REPO, jobId: 4, runIds: [20], headNumbers: []});

    /* When */
    for (let waited = 0; waited <= BUMP_WAIT_MS; waited += BUMP_LOOK_MS) {
        advance(BUMP_LOOK_MS);
        timers.tick();
        await settle();
    }

    /* Then */
    assert.equal(timers.pending, 0);
    assert.ok(!github.calls.includes('rerun 20'));
    assert.match(ok(await service.read(REPO)).notes[4], /did not stop within 2 minutes/);
});
