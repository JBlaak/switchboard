/**
 * acme/api's project page with a merge queue (#315), as main would answer it:
 * the plans fixture's overview, with more open PRs and the queue built from
 * them by the real rule (`mergeQueue`). The head is #1320, which the
 * login-fix session linked; behind it #1331 (next), a stack of three and a
 * PR held for @sam's review; #1360 failed its unit tests; #1380's status is
 * one the page does not know; and a draft, a PR waiting on its base and an
 * approved one nobody queued are not in it yet.
 *
 * Its CI job queue: one pool of two Mac runners, both busy with the head's
 * tests and #1331's, and three jobs queued behind them, the last of which
 * (#1370's) can be bumped past the two ahead of it.
 */
import {FIXTURE_NOW} from '../support/fixture-home';
import {acmeOverview, overviewPullRequest} from './plans';
import {mergeQueue, type QueuePullRequest} from '../../src/domain/project/merge-queue';
import {ciJobQueue, type CiJob, type CiJobQueueAnswer} from '../../src/domain/project/ci-job-queue';
import type {ProjectOverview, ProjectPullRequest} from '../../src/domain/project/overview';
import type {MergeQueueStub} from '../support/main-process';

const REPO = 'acme/api';
const MIN = 60_000;

function queued(
    number: number,
    title: string,
    headRef: string,
    fields: Partial<QueuePullRequest> = {},
): QueuePullRequest {
    return {
        number,
        title,
        url: `https://github.com/${REPO}/pull/${number}`,
        headRef,
        baseRef: 'main',
        draft: false,
        labels: [],
        automerge: null,
        review: 'approved',
        requestedReviewers: [],
        approvedBy: ['ana'],
        checks: [],
        ...fields,
    };
}

const status = (description: string, state: 'pending' | 'failure' = 'pending') => ({state, description});
const passed = (name: string) => ({name, state: 'passed' as const, startedAt: FIXTURE_NOW - 15 * MIN});

/** The open PRs as the queue reads them, the plans fixture's three among them. */
export const QUEUE_PULL_REQUESTS: QueuePullRequest[] = [
    queued(1320, 'Stop the login redirect loop', 'fix/1320', {
        labels: ['automerge:opt-in', 'bot: first in queue'],
        automerge: status('First in the merge queue; merges once CI passes'),
        checks: [
            passed('Lint'),
            passed('Typecheck'),
            passed('Unit tests'),
            {name: 'Integration tests', state: 'running', startedAt: FIXTURE_NOW - 15 * MIN},
            {name: 'Build', state: 'queued', startedAt: null},
        ],
    }),
    queued(1331, 'Bump express to 5.1', 'dependabot/npm/express-5.1', {
        labels: ['automerge:opt-in', 'automerge:next'],
        automerge: status('Number 2 in the merge queue'),
    }),
    queued(1340, 'Rate limit store', 'rate-limit/store', {labels: ['bot: merges with stack']}),
    queued(1341, 'Rate limit middleware', 'rate-limit/middleware', {
        baseRef: 'rate-limit/store',
        labels: ['bot: merges with stack'],
    }),
    queued(1342, 'Rate limit headers', 'rate-limit/headers', {
        baseRef: 'rate-limit/middleware',
        labels: ['automerge:opt-in'],
        automerge: status('Number 3 in the merge queue'),
    }),
    queued(1350, 'Bump TypeScript to 5.9', 'deps/typescript-5.9', {
        labels: ['automerge:opt-in'],
        review: 'review_required',
        approvedBy: [],
        requestedReviewers: ['sam'],
        automerge: status('Waits for a review by @sam'),
    }),
    queued(1360, 'Log the webhook retries', 'webhooks/log-retries', {
        labels: ['automerge:opt-in', 'automerge:failed'],
        automerge: status('CI failed: WebhookRetryTest › logs every attempt', 'failure'),
        checks: [passed('Lint'), {name: 'Unit tests', state: 'failed', startedAt: FIXTURE_NOW - 30 * MIN}],
    }),
    queued(1380, 'Rotate the signing keys', 'keys/rotate', {
        labels: ['automerge:opt-in'],
        automerge: status('Paused by an admin until Friday'),
    }),
    queued(1330, 'Try a token-bucket rate limiter', 'rate-limiter', {
        draft: true,
        review: null,
        approvedBy: [],
        automerge: status('A draft is not queued'),
    }),
    queued(1371, 'Health check behind the proxy', 'health/proxy', {
        baseRef: 'fix/1320',
        automerge: status('Waits until fix/1320 merges'),
    }),
    queued(1370, 'Add a health endpoint', 'health/endpoint'),
];

/** The queue, as the overview carries it: estimates from five green runs, a median of 24 min. */
export function acmeQueue() {
    return mergeQueue({
        trunk: 'main',
        pullRequests: QUEUE_PULL_REQUESTS,
        ciRunDurationsMs: [20, 22, 24, 26, 30].map((m) => m * MIN),
        now: FIXTURE_NOW,
    });
}

/** acme/api's overview with the queue, and a Pull requests row for each of its open PRs. */
export function acmeQueueOverview(): ProjectOverview {
    const overview = acmeOverview();
    if (!overview.github?.ok) throw new Error('the plans fixture answers GitHub');
    const known = new Set(overview.github.pullRequests.map((row) => row.pullRequest.number));
    const added = QUEUE_PULL_REQUESTS.filter((pr) => !known.has(pr.number)).map((pr) => ({
        pullRequest: overviewPullRequest(pr.number, pr.title, pr.headRef, {
            draft: pr.draft,
            review: pr.review,
        }) as ProjectPullRequest,
        closes: [],
        plan: null,
    }));
    const rows = overview.github.pullRequests;
    const open = rows.filter((row) => row.pullRequest.state === 'open');
    const merged = rows.filter((row) => row.pullRequest.state !== 'open');
    return {
        ...overview,
        github: {...overview.github, pullRequests: [...open, ...added, ...merged], mergeQueue: acmeQueue()},
    };
}

const MAC = ['self-hosted', 'macOS', 'ARM64'];

function ciJob(id: number, pr: number, title: string, fields: Partial<CiJob> = {}): CiJob {
    return {
        id,
        runId: id * 10,
        url: `https://github.com/${REPO}/actions/runs/${id * 10}/job/${id}`,
        workflow: 'CI',
        workflowId: 1,
        name: 'Unit tests',
        status: 'queued',
        createdAt: FIXTURE_NOW - 5 * MIN,
        startedAt: null,
        runner: null,
        labels: MAC,
        on: {kind: 'pr', number: pr, title},
        actor: 'ana',
        ...fields,
    };
}

/** The CI job queue: two busy Macs, three jobs waiting; each job typically runs 12 minutes. */
export function acmeCiJobs(): CiJobQueueAnswer {
    const running = (id: number, pr: number, title: string, runner: string, minutes: number) =>
        ciJob(id, pr, title, {
            status: 'running',
            runner,
            createdAt: FIXTURE_NOW - (minutes + 1) * MIN,
            startedAt: FIXTURE_NOW - minutes * MIN,
        });
    const pools = ciJobQueue({
        jobs: [
            running(1, 1320, 'Stop the login redirect loop', 'mac-1', 9),
            running(2, 1331, 'Bump express to 5.1', 'mac-2', 4),
            ciJob(3, 1340, 'Split the auth module', {createdAt: FIXTURE_NOW - 6 * MIN, actor: 'sam'}),
            ciJob(4, 1350, 'Bump TypeScript to 5.9', {createdAt: FIXTURE_NOW - 4 * MIN, actor: 'sam'}),
            ciJob(5, 1370, 'Add a health endpoint', {createdAt: FIXTURE_NOW - 2 * MIN}),
        ],
        runners: [
            {name: 'mac-1', labels: MAC, busy: true, online: true},
            {name: 'mac-2', labels: MAC, busy: true, online: true},
        ],
        typical: () => 12 * MIN,
        otherSince: () => null,
        now: FIXTURE_NOW,
    });
    return {ok: true, pools, fetchedAt: FIXTURE_NOW, notes: {}};
}

/** The queue's channels: no errands yet, and every button answering as it would. */
export function mergeQueueStub(fields: Partial<MergeQueueStub> = {}): MergeQueueStub {
    return {
        ciJobs: acmeCiJobs(),
        bump: {ok: true, runs: 2},
        errands: [],
        nudge: {ok: true, errandId: 'errand-nudge', prompt: 'Send a Slack message for me.'},
        fix: {ok: false, reason: 'Fix in session is not stubbed in this suite'},
        retry: {ok: true},
        optIn: {ok: true},
        ...fields,
    };
}
