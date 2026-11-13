import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {RestBugsnagApi, retryAfterMs} from '../src/infrastructure/bugsnag/rest-bugsnag-api';
import {BugsnagApiError} from '../src/application/ports/bugsnag-api';
import type {Fetch} from '../src/infrastructure/bugsnag/rest-bugsnag-api';

const TOKEN = 'test-token-abcd';
const ORG = '5f1a2b3c4d5e6f7a8b9c0d1e';
const PROJECT = '6a0000000000000000000001';
const ERROR = '6b0000000000000000000011';

function fixture(name: string): string {
    return fs.readFileSync(path.join(__dirname, 'fixtures', 'bugsnag', name), 'utf8');
}

interface Call {
    url: URL;
    init: RequestInit;
}

interface Reply {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
}

/** A fetch answering from `routes` (path → replies, used in turn), recording every call. */
function fakeFetch(routes: Record<string, Reply[]>) {
    const calls: Call[] = [];
    const fetch: Fetch = async (url, init) => {
        const parsed = new URL(url);
        calls.push({url: parsed, init});
        const replies = routes[parsed.pathname];
        const reply = replies?.length
            ? replies.length > 1
                ? replies.shift()!
                : replies[0]
            : {status: 404, body: '{}'};
        return new Response(reply.body ?? '', {status: reply.status ?? 200, headers: reply.headers ?? {}});
    };
    return {fetch, calls};
}

const quietLog = {debug() {}, info() {}, warn() {}, error() {}};

function api(fetch: Fetch, sleeps: number[] = []) {
    return new RestBugsnagApi({
        token: TOKEN,
        log: quietLog,
        fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
    });
}

test('projects are listed across every page of every organization', async () => {
    /* Given */
    const next = `https://api.bugsnag.com/organizations/${ORG}/projects?offset=1&per_page=100`;
    const {fetch} = fakeFetch({
        '/user/organizations': [{body: fixture('organizations.json')}],
        [`/organizations/${ORG}/projects`]: [
            {body: fixture('projects-page-1.json'), headers: {link: `<${next}>; rel="next"`}},
            {body: fixture('projects-page-2.json')},
        ],
    });

    /* When */
    const projects = await api(fetch).listProjects();

    /* Then */
    assert.deepEqual(projects, [
        {
            id: '6a0000000000000000000001',
            name: 'Connect API - Production',
            slug: 'connect-api-production',
            htmlUrl: 'https://app.bugsnag.com/example-studio/connect-api-production',
        },
        {
            id: '6a0000000000000000000002',
            name: 'Connect Web - Production',
            slug: 'connect-web-production',
            htmlUrl: 'https://app.bugsnag.com/example-studio/connect-web-production',
        },
    ]);
});

test('every request carries the token in its header and nowhere in its URL', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch({
        '/user/organizations': [{body: fixture('organizations.json')}],
        [`/organizations/${ORG}/projects`]: [{body: fixture('projects-page-1.json')}],
    });

    /* When */
    await api(fetch).listProjects();

    /* Then */
    for (const call of calls) {
        const headers = call.init.headers as Record<string, string>;
        assert.equal(headers.Authorization, `token ${TOKEN}`);
        assert.equal(headers['X-Version'], '2');
        assert.ok(!call.url.toString().includes(TOKEN));
    }
});

test('errors are mapped from the list, with the next page and the total', async () => {
    /* Given */
    const next = `https://api.bugsnag.com/projects/${PROJECT}/errors?offset=2&per_page=2`;
    const {fetch, calls} = fakeFetch({
        [`/projects/${PROJECT}/errors`]: [
            {body: fixture('errors.json'), headers: {link: `<${next}>; rel="next"`, 'x-total-count': '12'}},
        ],
    });

    /* When */
    const page = await api(fetch).listErrors(PROJECT, {
        since: new Date('2026-11-06T00:00:00Z'),
        releaseStage: 'production',
        sort: 'first_seen',
        perPage: 2,
    });

    /* Then */
    assert.equal(page.total, 12);
    assert.equal(page.next, next);
    assert.deepEqual(page.errors[0], {
        id: ERROR,
        projectId: PROJECT,
        errorClass: 'TypeError',
        message: "Cannot read properties of undefined (reading 'rows')",
        context: 'GET /api/workouts',
        severity: 'error',
        status: 'open',
        events: 148,
        users: 37,
        firstSeen: '2026-11-12T22:14:03.000Z',
        lastSeen: '2026-11-13T08:02:41.000Z',
        firstSeenUnfiltered: '2026-11-12T22:14:03.000Z',
        releaseStages: ['production'],
        linkedIssues: [],
    });
    assert.equal(page.errors[1].firstSeenUnfiltered, '2025-08-16T13:29:38.000Z');
    assert.deepEqual(page.errors[1].linkedIssues, ['https://github.com/example/connect/pull/359']);
    const params = calls[0].url.searchParams;
    assert.equal(params.get('sort'), 'first_seen');
    assert.equal(params.get('per_page'), '2');
    assert.deepEqual(params.getAll('filters[error.status][][value]'), ['open']);
    assert.deepEqual(params.getAll('filters[event.since][][value]'), ['2026-11-06T00:00:00.000Z']);
    assert.deepEqual(params.getAll('filters[app.release_stage][][value]'), ['production']);
});

test('the next page is fetched from the URL Bugsnag gave', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch({[`/projects/${PROJECT}/errors`]: [{body: '[]'}]});
    const next = `https://api.bugsnag.com/projects/${PROJECT}/errors?offset=30&per_page=30`;

    /* When */
    await api(fetch).listErrors(PROJECT, {page: next});

    /* Then */
    assert.equal(calls[0].url.toString(), next);
});

test('a page URL on another host is refused, so the token never leaves for it', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch({});

    /* When */
    const listing = api(fetch).listErrors(PROJECT, {page: 'https://evil.example.com/projects/x/errors'});

    /* Then */
    await assert.rejects(listing, BugsnagApiError);
    assert.equal(calls.length, 0);
});

test('an error trend comes back as daily buckets, oldest first, the last ending now', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch({[`/projects/${PROJECT}/errors/${ERROR}/trend`]: [{body: fixture('trend.json')}]});

    /* When */
    const trend = await api(fetch).errorTrend(PROJECT, ERROR, 7);

    /* Then */
    assert.deepEqual(
        trend.map((bucket) => bucket.events),
        [2, 0, 3, 1, 4, 18, 120],
    );
    assert.equal(trend[6].to, '2026-11-13T18:57:33Z');
    assert.equal(calls[0].url.searchParams.get('buckets_count'), '7');
    assert.deepEqual(calls[0].url.searchParams.getAll('filters[event.since][][value]'), ['7d']);
});

test('events since a time come back with their app version, full report or summary', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch({
        [`/projects/${PROJECT}/errors/${ERROR}/events`]: [{body: fixture('events.json')}],
    });

    /* When */
    const events = await api(fetch).eventsSince(PROJECT, ERROR, new Date('2026-11-13T00:00:00Z'));

    /* Then */
    assert.deepEqual(events, [
        {
            id: '6c0000000000000000000101',
            receivedAt: '2026-11-13T08:02:41.512Z',
            appVersion: '4.12.1',
            releaseStage: 'production',
        },
        {
            id: '6c0000000000000000000102',
            receivedAt: '2026-11-13T07:40:00.000Z',
            appVersion: null,
            releaseStage: 'production',
        },
        {
            id: '6c0000000000000000000103',
            receivedAt: '2026-11-13T07:12:09.000Z',
            appVersion: '4.11.0',
            releaseStage: 'staging',
        },
    ]);
    assert.deepEqual(calls[0].url.searchParams.getAll('filters[event.since][][value]'), ['2026-11-13T00:00:00.000Z']);
    assert.equal(calls[0].url.searchParams.get('full_reports'), 'true');
});

test("an error's newest event comes with its stack, in-project frames marked", async () => {
    /* Given */
    const {fetch, calls} = fakeFetch({
        [`/projects/${PROJECT}/errors/${ERROR}/events`]: [{body: fixture('events.json')}],
    });

    /* When */
    const event = await api(fetch).eventDetail(PROJECT, ERROR, 'latest');

    /* Then */
    assert.equal(event?.appVersion, '4.12.1');
    assert.deepEqual(event?.frames, [
        {file: 'node_modules/pg/lib/result.js', line: 70, method: 'Result.parse', inProject: false},
        {file: 'src/workouts/list.ts', line: 41, method: 'listWorkouts', inProject: true},
        {file: 'src/http/routes.ts', line: 12, method: 'handle', inProject: true},
    ]);
    assert.equal(calls[0].url.searchParams.get('per_page'), '1');
    assert.equal(calls[0].url.searchParams.get('direction'), 'desc');
});

test("an error's oldest event is asked for oldest first", async () => {
    /* Given */
    const {fetch, calls} = fakeFetch({
        [`/projects/${PROJECT}/errors/${ERROR}/events`]: [{body: '[]'}],
    });

    /* When */
    const event = await api(fetch).eventDetail(PROJECT, ERROR, 'first');

    /* Then */
    assert.equal(event, null);
    assert.equal(calls[0].url.searchParams.get('direction'), 'asc');
});

test('fix and link_issue are sent as operations on the error', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch({[`/projects/${PROJECT}/errors/${ERROR}`]: [{body: '{}'}]});
    const bugsnag = api(fetch);

    /* When */
    await bugsnag.fix(PROJECT, ERROR);
    await bugsnag.linkIssue(PROJECT, ERROR, 'https://github.com/example/connect/pull/400');

    /* Then */
    assert.deepEqual(
        calls.map((call) => [call.init.method, JSON.parse(String(call.init.body))]),
        [
            ['PATCH', {operation: 'fix'}],
            ['PATCH', {operation: 'link_issue', issue_url: 'https://github.com/example/connect/pull/400'}],
        ],
    );
});

test('a 429 waits for its Retry-After and tries again', async () => {
    /* Given */
    const sleeps: number[] = [];
    const {fetch, calls} = fakeFetch({
        '/user/organizations': [
            {status: 429, body: '{"errors":["API rate limit exceeded"]}', headers: {'retry-after': '7'}},
            {body: '[]'},
        ],
    });

    /* When */
    const projects = await api(fetch, sleeps).listProjects();

    /* Then */
    assert.deepEqual(projects, []);
    assert.deepEqual(sleeps, [7000]);
    assert.equal(calls.length, 2);
});

test('rate limiting that does not let up gives up as rate-limited after three retries', async () => {
    /* Given */
    const sleeps: number[] = [];
    const {fetch, calls} = fakeFetch({'/user/organizations': [{status: 429, body: '{}'}]});

    /* When */
    const listing = api(fetch, sleeps).listProjects();

    /* Then */
    await assert.rejects(listing, (err: BugsnagApiError) => err.failure === 'rate-limited');
    assert.deepEqual(sleeps, [1000, 2000, 4000]);
    assert.equal(calls.length, 4);
});

test('a refused token fails as unauthorized, without the token in the message', async () => {
    /* Given */
    const {fetch} = fakeFetch({'/user/organizations': [{status: 401, body: '{"errors":["Unauthorized"]}'}]});

    /* When */
    const listing = api(fetch).listProjects();

    /* Then */
    await assert.rejects(listing, (err: BugsnagApiError) => {
        return err.failure === 'unauthorized' && !err.message.includes(TOKEN);
    });
});

test('a dropped connection fails as unreachable', async () => {
    /* Given */
    const fetch: Fetch = async () => {
        throw new TypeError('fetch failed');
    };

    /* When */
    const listing = api(fetch).listProjects();

    /* Then */
    await assert.rejects(listing, (err: BugsnagApiError) => err.failure === 'unreachable');
});

test('Retry-After is capped at a minute', () => {
    /* When */
    const wait = retryAfterMs('3600', 0);

    /* Then */
    assert.equal(wait, 60_000);
});
