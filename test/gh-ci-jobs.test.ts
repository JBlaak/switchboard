/**
 * The CI job queue's REST answers, as `gh api` returns them, mapped onto the
 * `ci-job-queue` domain (`gh-ci-jobs.ts`).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    toActiveRuns,
    toCiJobs,
    toRunCompleted,
    toRunIds,
    toRunners,
    toTimedRun,
} from '../src/infrastructure/github/gh-ci-jobs';

test('runners map with their label names, busy and online', () => {
    /* Given */
    const body = {
        total_count: 2,
        runners: [
            {id: 1, name: 'mini', status: 'online', busy: true, labels: [{name: 'self-hosted'}, {name: 'macOS'}]},
            {id: 2, name: 'mbp', status: 'offline', busy: false, labels: []},
        ],
    };

    /* When */
    const runners = toRunners(body);

    /* Then */
    assert.deepEqual(runners, [
        {name: 'mini', labels: ['self-hosted', 'macOS'], busy: true, online: true},
        {name: 'mbp', labels: [], busy: false, online: false},
    ]);
    assert.equal(toRunners({message: 'Must have admin rights'}), null);
});

test('only unfinished runs are kept, each with the open PR it runs for: named on it, or by its branch', () => {
    /* Given */
    const runs = {
        workflow_runs: [
            {id: 1, name: 'CI', workflow_id: 7, status: 'in_progress', head_branch: 'a', pull_requests: [{number: 12}]},
            {
                id: 2,
                name: 'CI',
                workflow_id: 7,
                status: 'queued',
                head_branch: 'b',
                pull_requests: [],
                actor: {login: 'sam'},
            },
            {id: 3, name: 'CI', workflow_id: 7, status: 'queued', head_branch: 'main', pull_requests: []},
            {id: 4, name: 'CI', workflow_id: 7, status: 'completed', head_branch: 'c', pull_requests: []},
        ],
    };
    const pulls = [
        {number: 12, title: 'Named', head: {ref: 'a'}},
        {number: 13, title: 'By branch', head: {ref: 'b'}},
    ];

    /* When */
    const active = toActiveRuns(runs, pulls);

    /* Then */
    assert.deepEqual(
        active?.map((run) => [run.id, run.on, run.actor]),
        [
            [1, {kind: 'pr', number: 12, title: 'Named'}, null],
            [2, {kind: 'pr', number: 13, title: 'By branch'}, 'sam'],
            [3, {kind: 'branch', branch: 'main'}, null],
        ],
    );
});

test('a run’s running and queued jobs map with their labels, runner and times; finished ones are left out', () => {
    /* Given */
    const run = {id: 5, workflow: 'CI', workflowId: 7, on: {kind: 'branch' as const, branch: 'main'}, actor: null};
    const body = {
        jobs: [
            {
                id: 50,
                name: 'Tests',
                status: 'in_progress',
                created_at: '2026-11-06T10:00:00Z',
                started_at: '2026-11-06T10:02:00Z',
                runner_name: 'mini',
                labels: ['self-hosted', 'macOS'],
                html_url: 'https://github.com/o/r/actions/runs/5/job/50',
            },
            {
                id: 51,
                name: 'Build',
                status: 'queued',
                created_at: '2026-11-06T10:01:00Z',
                started_at: '2026-11-06T10:01:00Z',
                runner_name: null,
                labels: ['self-hosted'],
            },
            {id: 52, name: 'Lint', status: 'completed', conclusion: 'success', labels: []},
        ],
    };

    /* When */
    const jobs = toCiJobs(run, body);

    /* Then */
    assert.deepEqual(
        jobs.map((job) => [job.id, job.status, job.runner, job.startedAt, job.labels]),
        [
            [50, 'running', 'mini', Date.parse('2026-11-06T10:02:00Z'), ['self-hosted', 'macOS']],
            [51, 'queued', null, null, ['self-hosted']],
        ],
    );
    assert.equal(jobs[0].runId, 5);
    assert.equal(jobs[0].workflowId, 7);
});

test('a successful run is timed by its succeeded jobs, start to end', () => {
    /* Given */
    const body = {
        jobs: [
            {
                name: 'Tests',
                conclusion: 'success',
                started_at: '2026-11-06T10:00:00Z',
                completed_at: '2026-11-06T10:12:00Z',
            },
            {
                name: 'Flaky',
                conclusion: 'failure',
                started_at: '2026-11-06T10:00:00Z',
                completed_at: '2026-11-06T10:01:00Z',
            },
        ],
    };

    /* When */
    const timed = toTimedRun(9, 7, body);

    /* Then */
    assert.deepEqual(timed, {runId: 9, workflowId: 7, jobs: {Tests: 12 * 60_000}});
    assert.equal(toTimedRun(9, 7, {jobs: []}), null);
});

test('a workflow’s runs answer their ids, and a run whether it stopped', () => {
    /* When */
    const ids = toRunIds({workflow_runs: [{id: 3}, {id: 2}]});
    const stopped = [
        toRunCompleted({status: 'completed'}),
        toRunCompleted({status: 'in_progress'}),
        toRunCompleted({}),
    ];

    /* Then */
    assert.deepEqual(ids, [3, 2]);
    assert.deepEqual(stopped, [true, false, null]);
});
