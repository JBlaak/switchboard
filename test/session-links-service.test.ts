import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    LINKS_GITHUB_TTL_MS,
    SessionLinksService,
    type SessionLinksServiceDeps,
} from '../src/application/services/session-links-service';
import type {TranscriptProducts} from '../src/application/ports/transcript-store';
import type {GitHubAvailability, IssueRef, IssueStatus, PullRequestStatus} from '../src/domain/session-work/model';
import type {SessionPullRequest} from '../src/domain/session/session';
import type {BlaakTasksResult, TaskDetail} from '../src/domain/tasks/model';
import {silentLog} from './support/fakes';

/**
 * The session tray's links (#340): one answer from what is kept, never
 * waiting on `gh` or BlaakTasks, with what went stale asked again behind it.
 */

const SESSION = 'session-1';
const REPO = 'acme/web';
const PR: SessionPullRequest = {number: 12, url: 'https://github.com/acme/web/pull/12', repository: REPO};

interface World {
    deps: SessionLinksServiceDeps;
    now: number;
    fingerprint: string | null;
    mentions: IssueRef[];
    products: TranscriptProducts;
    pullRequests: SessionPullRequest[];
    availability: GitHubAvailability;
    /** What `gh pullRequests` answers; a promise to hold it back. */
    prAnswer: () => Promise<PullRequestStatus[] | null>;
    issueAnswer: () => Promise<IssueStatus[] | null>;
    taskId: string | null;
    taskAnswer: () => Promise<BlaakTasksResult<TaskDetail>>;
    watched: Map<string, PullRequestStatus>;
    reads: number;
    ghCalls: number;
}

function world(): World {
    const w: World = {
        now: 1_000,
        fingerprint: 'v1',
        mentions: [],
        products: {artifacts: [], pages: []},
        pullRequests: [PR],
        availability: 'ok',
        prAnswer: async () => [],
        issueAnswer: async () => [],
        taskId: null,
        taskAnswer: async () => ({kind: 'off'}),
        watched: new Map(),
        reads: 0,
        ghCalls: 0,
        deps: undefined as unknown as SessionLinksServiceDeps,
    };
    w.deps = {
        locate: () => ({folder: '-repo', projectPath: '/repo'}),
        pullRequests: () => w.pullRequests,
        transcripts: {
            sessionFingerprint: () => w.fingerprint,
            issueMentions: () => {
                w.reads++;
                return w.mentions;
            },
            products: () => w.products,
        },
        remotes: {originUrl: async () => 'git@github.com:acme/web.git'},
        github: {
            available: async () => w.availability,
            pullRequests: () => {
                w.ghCalls++;
                return w.prAnswer();
            },
            issues: () => w.issueAnswer(),
        },
        watchedStatus: (url) => w.watched.get(url) ?? null,
        tasks: {sessionTask: () => w.taskId, get: () => w.taskAnswer()},
        clock: {now: () => w.now},
        log: silentLog,
    };
    return w;
}

const openStatus: PullRequestStatus = {...PR, title: 'Add the tray', state: 'open', checks: [], closes: []};

test('the first answer comes before gh does, with the PR and no status', async () => {
    /* Given */
    const w = world();
    w.prAnswer = () => new Promise(() => {});
    const service = new SessionLinksService(w.deps);

    /* When */
    const links = await service.links(SESSION);

    /* Then */
    assert.deepEqual(
        links.map((link) => [link.kind, link.title, link.status]),
        [['pr', 'acme/web#12', null]],
    );
});

test("once gh has answered behind it, the next answer has the PR's status", async () => {
    /* Given */
    const w = world();
    w.prAnswer = async () => [openStatus];
    const service = new SessionLinksService(w.deps);
    await service.links(SESSION);
    await service.refresh(SESSION);

    /* When */
    const links = await service.links(SESSION);

    /* Then */
    assert.deepEqual(
        links.map((link) => [link.title, link.status]),
        [['Add the tray', {state: 'open', checks: 'none', dot: 'green'}]],
    );
});

test('without gh the PRs come back without status, and gh is not asked about them', async () => {
    /* Given */
    const w = world();
    w.availability = 'missing';
    const service = new SessionLinksService(w.deps);
    await service.links(SESSION);
    await service.refresh(SESSION);

    /* When */
    const links = await service.links(SESSION);

    /* Then */
    assert.deepEqual(
        links.map((link) => link.status),
        [null],
    );
    assert.equal(w.ghCalls, 0);
});

test("what the CI watch heard about a PR is used before gh's own answer arrives", async () => {
    /* Given */
    const w = world();
    w.prAnswer = () => new Promise(() => {});
    w.watched.set(PR.url, {...openStatus, state: 'merged'});
    const service = new SessionLinksService(w.deps);

    /* When */
    const links = await service.links(SESSION);

    /* Then */
    assert.deepEqual(
        links.map((link) => link.status),
        [{state: 'merged', checks: 'none', dot: 'merged'}],
    );
});

test('gh is asked again only once its answer is a minute old', async () => {
    /* Given */
    const w = world();
    const service = new SessionLinksService(w.deps);
    await service.links(SESSION);
    await service.refresh(SESSION);
    await service.links(SESSION);
    await service.refresh(SESSION);
    const early = w.ghCalls;
    w.now += LINKS_GITHUB_TTL_MS;

    /* When */
    await service.links(SESSION);
    await service.refresh(SESSION);

    /* Then */
    assert.deepEqual([early, w.ghCalls], [1, 2]);
});

test('the transcript is read again once it was written to', async () => {
    /* Given */
    const w = world();
    const service = new SessionLinksService(w.deps);
    await service.links(SESSION);
    w.fingerprint = 'v2';
    w.products = {artifacts: [{id: 'A1', url: 'https://claude.ai/artifact/A1', title: 'Report'}], pages: []};
    await service.links(SESSION);
    await service.refresh(SESSION);

    /* When */
    const links = await service.links(SESSION);

    /* Then */
    assert.deepEqual(
        links.map((link) => link.key),
        ['pr:' + PR.url, 'artifact:A1'],
    );
});

test('issues, artifacts, pages and the task come back with the PRs in one answer', async () => {
    /* Given */
    const w = world();
    w.mentions = [{repository: '', number: 7}];
    w.issueAnswer = async () => [
        {
            repository: REPO,
            number: 7,
            title: 'The bar is busy',
            state: 'open',
            url: 'https://github.com/acme/web/issues/7',
        },
    ];
    w.products = {
        artifacts: [{id: 'A1', url: 'https://claude.ai/artifact/A1', title: null}],
        pages: [{id: 'p1', title: 'Summary', shownAt: 5}],
    };
    w.taskId = 'task-1';
    w.taskAnswer = async () => ({
        kind: 'ok',
        value: {title: 'Ship the tray', url: 'https://notion.so/t1', status: 'In progress'} as TaskDetail,
    });
    const service = new SessionLinksService(w.deps);
    await service.links(SESSION);
    await service.refresh(SESSION);

    /* When */
    const links = await service.links(SESSION);

    /* Then */
    assert.deepEqual(
        links.map((link) => [link.kind, link.title]),
        [
            ['pr', 'acme/web#12'],
            ['issue', 'The bar is busy'],
            ['artifact', 'A1'],
            ['page', 'Summary'],
            ['task', 'Ship the tray'],
        ],
    );
});

test('the task shows before BlaakTasks answers, by its id alone', async () => {
    /* Given */
    const w = world();
    w.pullRequests = [];
    w.taskId = 'task-1';
    w.taskAnswer = () => new Promise(() => {});
    const service = new SessionLinksService(w.deps);

    /* When */
    const links = await service.links(SESSION);

    /* Then */
    assert.deepEqual(links, [{kind: 'task', key: 'task:task-1', title: 'Task', id: 'task-1', url: null, status: null}]);
});
