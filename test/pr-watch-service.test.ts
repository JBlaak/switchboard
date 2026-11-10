import {test} from 'node:test';
import assert from 'node:assert/strict';

import {PrWatchService, type WatchedSession} from '../src/application/services/pr-watch-service';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import type {GitHubAvailability} from '../src/application/ports/github-cli';
import type {CheckRun, PullRequestStatus} from '../src/domain/session-work/model';
import type {PullRequestStatusChange} from '../src/domain/session-work/status';

const REPO = 'o/app';
const ROOT = '/code/app';
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const RUN = 'https://github.com/o/app/actions/runs/1/job/2';

function status(headSha: string, state: CheckRun['state'], more: Partial<PullRequestStatus> = {}): PullRequestStatus {
    return {
        number: 7,
        url: url(7),
        repository: REPO,
        state: 'open',
        headSha,
        headRef: 'feat/7',
        baseRef: 'main',
        checks: [
            {name: 'build', state: 'passing'},
            {name: 'test', state, url: RUN},
        ],
        closes: [],
        ...more,
    };
}

/** `gh`, answering from a table the test edits between polls. */
class FakeGitHub {
    public availability: GitHubAvailability = 'ok';
    public prs = new Map<number, PullRequestStatus>();
    public calls: Array<[string, number[]]> = [];
    public async available() {
        return this.availability;
    }
    public async pullRequests(repo: string, numbers: readonly number[]) {
        this.calls.push([repo, [...numbers]]);
        return numbers.flatMap((n) => (this.prs.has(n) ? [{...this.prs.get(n)!}] : []));
    }
    public async checkLogTail() {
        return 'FAIL src/login.test.ts\nexpected 2, got 3';
    }
}

const SESSION: WatchedSession = {
    sessionId: 's1',
    projectPath: ROOT,
    pullRequests: [{number: 7, url: url(7), repository: REPO}],
};

function setup({github = new FakeGitHub(), sessions = [SESSION]} = {}) {
    const renderer = fakeRenderer();
    const timers = fakeTimers();
    // Only running sessions are watched, as the registry would say.
    const running = {sessions};
    const watch = new PrWatchService({
        sessions: () => running.sessions,
        github,
        renderer,
        timers,
        log: silentLog,
    });
    const dots = () => renderer.only('prStatusChanged').map((event) => event[1] as PullRequestStatusChange);
    return {watch, github, timers, dots, running};
}

test('one gh request per repository, however many sessions and PRs', async () => {
    /* Given */
    const github = new FakeGitHub();
    const other: WatchedSession = {
        sessionId: 's2',
        projectPath: ROOT,
        pullRequests: [
            {number: 8, url: url(8), repository: ''},
            {number: 7, url: url(7), repository: REPO},
        ],
    };
    const {watch} = setup({github, sessions: [SESSION, other]});
    github.prs.set(7, status('aaa', 'passing'));
    github.prs.set(8, status('bbb', 'passing', {number: 8, url: url(8)}));

    /* When */
    await watch.poll();

    /* Then */
    assert.deepEqual(github.calls, [[REPO, [7, 8]]]);
});

test('a merged PR is not asked about again', async () => {
    /* Given */
    const {watch, github, dots} = setup();
    github.prs.set(7, status('aaa', 'passing', {state: 'merged'}));

    /* When */
    await watch.poll();
    await watch.poll();

    /* Then */
    assert.equal(github.calls.length, 1);
    assert.deepEqual(dots(), [{sessionId: 's1', prs: [{number: 7, dot: 'merged'}], needsYou: false}]);
});

test('an open PR with auto-merge on says so on its dot', async () => {
    /* Given */
    const {watch, github, dots} = setup();
    github.prs.set(7, status('aaa', 'passing', {autoMerge: true}));

    /* When */
    await watch.poll();

    /* Then */
    assert.deepEqual(dots(), [{sessionId: 's1', prs: [{number: 7, dot: 'green', autoMerge: true}], needsYou: false}]);
});

test('a closed PR says so on its dot', async () => {
    /* Given */
    const {watch, github, dots} = setup();
    github.prs.set(7, status('aaa', 'passing', {state: 'closed'}));

    /* When */
    await watch.poll();

    /* Then */
    assert.deepEqual(dots(), [{sessionId: 's1', prs: [{number: 7, dot: 'green', closed: true}], needsYou: false}]);
});

test("the minute's poll runs from start, and focus polls only while the watch is on", async () => {
    /* Given */
    const {watch, github, timers} = setup();
    github.prs.set(7, status('aaa', 'passing'));

    /* When */
    watch.focused();
    await new Promise((resolve) => setImmediate(resolve));

    /* Then */
    assert.equal(github.calls.length, 0);

    /* When */
    watch.start();
    await watch.poll();

    /* Then */
    assert.equal(github.calls.length, 1);

    /* When */
    timers.tick();
    await watch.poll();

    /* Then */
    assert.equal(github.calls.length, 2);

    /* When */
    watch.stop();

    /* Then */
    assert.equal(timers.pending, 0);
});

test("a PR's state is what gh last answered, and unknown before it answered", async () => {
    /* Given */
    const {watch, github} = setup();
    github.prs.set(7, status('aaa', 'passing', {state: 'merged'}));
    const before = watch.stateOf(url(7));

    /* When */
    await watch.poll();

    /* Then */
    assert.equal(before, null);
    assert.equal(watch.stateOf(url(7)), 'merged');
    assert.equal(watch.stateOf(url(8)), null);
});

test('dots are pushed only when they change, and gone when the session stops', async () => {
    /* Given */
    const {watch, github, dots, running} = setup();
    github.prs.set(7, status('aaa', 'pending'));

    /* When */
    await watch.poll();
    await watch.poll();

    /* Then */
    assert.deepEqual(dots(), [{sessionId: 's1', prs: [{number: 7, dot: 'amber'}], needsYou: false}]);

    /* When */
    github.prs.set(7, status('aaa', 'failing'));
    await watch.poll();

    /* Then */
    assert.deepEqual(dots().at(-1), {sessionId: 's1', prs: [{number: 7, dot: 'red'}], needsYou: false});

    /* When */
    running.sessions = [];
    await watch.poll();

    /* Then */
    assert.deepEqual(dots().at(-1), {sessionId: 's1', prs: [], needsYou: false});
});

test('gh missing or signed out: nothing is asked', async () => {
    /* Given */
    const {watch, github} = setup();
    github.availability = 'unauthenticated';
    github.prs.set(7, status('aaa', 'failing'));

    /* When */
    await watch.poll();

    /* Then */
    assert.deepEqual(github.calls, []);
});
