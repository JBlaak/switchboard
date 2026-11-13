import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    MergeQueueWatchService,
    QUEUE_RECHECK_MS,
    type QueueWatchedSession,
} from '../src/application/services/merge-queue-watch-service';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {errand, failed, head, held, MIN, NOW, prUrl, queued, queueOf, REPO} from './support/merge-queue-fixtures';
import type {MergeQueue} from '../src/domain/project/merge-queue';
import type {ProjectOverview, ProjectOverviewOptions} from '../src/domain/project/overview';
import type {QueueErrandView} from '../src/domain/project/queue-errands';
import type {MergeQueueChange} from '../src/domain/project/queue-elsewhere';

const ROOT = '/code/app';
const WORKTREE = '/code/app/.claude/worktrees/fix-4';
const OTHER = '/code/other';

/** What the overview answers per repository, edited between polls. */
interface Repo {
    queue: MergeQueue | null;
    /** Open PR numbers; the queue's by default. */
    open?: number[];
    unavailable?: boolean;
}

function overviewOf(projectPath: string, repository: string | null, repo: Repo | undefined): ProjectOverview {
    const open =
        repo?.open ??
        (repo?.queue
            ? [
                  ...(repo.queue.head ? [repo.queue.head.number] : []),
                  ...repo.queue.entries.map((entry) => entry.number),
                  ...repo.queue.failed.map((entry) => entry.number),
              ]
            : []);
    const github = !repo
        ? null
        : repo.unavailable
          ? {ok: false as const, reason: 'unreachable' as const}
          : {
                ok: true as const,
                fetchedAt: NOW,
                stale: false,
                plansPending: true,
                mergeQueue: repo.queue,
                plans: [],
                loose: [],
                pullRequests: open.map((number) => ({pullRequest: {number, state: 'open'}})),
            };
    return {projectPath, remote: false, repository, github, worktrees: [], running: []} as unknown as ProjectOverview;
}

function setup(sessions: QueueWatchedSession[]) {
    const repos = new Map<string, Repo>();
    const repositoryOf: Record<string, string> = {[ROOT]: REPO, [WORKTREE]: REPO, [OTHER]: 'o/other'};
    const asked: Array<[string, ProjectOverviewOptions | undefined]> = [];
    let errands: QueueErrandView[] = [];
    const settled: Array<[string, {number: number; reviewer: string}[]]> = [];
    const renderer = fakeRenderer();
    const timers = fakeTimers();
    const now = {value: NOW};
    const watch = new MergeQueueWatchService({
        sessions: () => sessions,
        overview: {
            overview: async (path, options) => {
                asked.push([path, options]);
                const repository = repositoryOf[path] ?? null;
                return overviewOf(path, repository, repository ? repos.get(repository) : undefined);
            },
        },
        errands: {
            errands: (repository) => errands.filter((candidate) => candidate.repository === repository),
            // As the errand service does: a nudge no held entry waits on any more is settled.
            settleNudges: (repository, entries) => {
                settled.push([repository, [...entries]]);
                errands = errands.map((view) =>
                    view.kind === 'nudge' &&
                    view.repository === repository &&
                    !entries.some((entry) => entry.number === view.number && entry.reviewer === view.reviewer)
                        ? {...view, settledAt: NOW}
                        : view,
                );
            },
        },
        renderer,
        timers,
        clock: {now: () => now.value},
        log: silentLog,
    });
    const pushes = () => renderer.only('mergeQueueChanged').map((event) => event[1] as MergeQueueChange);
    return {
        watch,
        repos,
        asked,
        renderer,
        timers,
        now,
        settled,
        pushes,
        setErrands: (next: QueueErrandView[]) => {
            errands = next;
        },
    };
}

const session = (sessionId: string, projectPath: string, prs: number[] = []): QueueWatchedSession => ({
    sessionId,
    projectPath,
    pullRequests: prs.map((number) => ({number, url: prUrl(number), repository: REPO})),
});

test('a repository using the queue is pushed with its errands, asked once without plans however many sessions are in it', async () => {
    /* Given */
    const {watch, repos, asked, pushes, setErrands} = setup([
        session('s1', ROOT, [2]),
        session('s2', WORKTREE),
        session('s3', ROOT),
    ]);
    const queue = queueOf([head(1), queued(2, 2)]);
    repos.set(REPO, {queue});
    setErrands([errand('s2')]);

    /* When */
    await watch.poll();

    /* Then */
    assert.deepEqual(asked, [
        [ROOT, {plans: false}],
        [WORKTREE, {plans: false}],
    ]);
    assert.deepEqual(pushes(), [{repository: REPO, queue, errands: [errand('s2')]}]);
});

test('a second poll with nothing changed pushes nothing, even though the estimates counted down', async () => {
    /* Given */
    const {watch, repos, pushes} = setup([session('s1', ROOT)]);
    repos.set(REPO, {queue: queueOf([head(1), queued(2, 2)], NOW)});
    await watch.poll();

    /* When */
    repos.set(REPO, {queue: queueOf([head(1), queued(2, 2)], NOW + MIN)});
    await watch.poll();

    /* Then */
    assert.equal(pushes().length, 1);
});

test('the queue moving, or an errand changing, is pushed again', async () => {
    /* Given */
    const {watch, repos, pushes, setErrands} = setup([session('s1', ROOT)]);
    repos.set(REPO, {queue: queueOf([head(1), queued(2, 2)])});
    await watch.poll();

    /* When */
    repos.set(REPO, {queue: queueOf([head(2)])});
    await watch.poll();
    setErrands([errand('s1', {state: 'needs-you'})]);
    await watch.poll();

    /* Then */
    assert.deepEqual(
        pushes().map((change) => [change.queue?.head?.number, change.errands.map((view) => view.state)]),
        [
            [1, []],
            [2, []],
            [2, ['needs-you']],
        ],
    );
});

test('each reading of a queue settles its nudges against the held entries, before its errands are read', async () => {
    /* Given */
    const {watch, repos, settled, setErrands, pushes} = setup([session('s1', ROOT), session('s2', OTHER)]);
    repos.set(REPO, {queue: queueOf([head(1), held(3, 'sam')])});
    repos.set('o/other', {queue: null});
    await watch.poll();

    /* When */
    repos.set(REPO, {queue: queueOf([head(1), held(3, 'anna')])});
    setErrands([errand('s9', {kind: 'nudge', number: 3, reviewer: 'sam', state: 'done'})]);
    await watch.poll();

    /* Then */
    assert.deepEqual(settled, [
        [REPO, [{number: 3, reviewer: 'sam'}]],
        [REPO, [{number: 3, reviewer: 'anna'}]],
    ]);
    assert.equal(pushes().at(-1)?.errands[0]?.settledAt, NOW);
});

test('a repository without the queue, without GitHub, or unreachable is never pushed', async () => {
    /* Given */
    const {watch, repos, pushes} = setup([session('s1', OTHER), session('s2', '/tmp/scratch')]);
    repos.set('o/other', {queue: null});

    /* When */
    await watch.poll();
    repos.set('o/other', {queue: null, unavailable: true});
    await watch.poll();

    /* Then */
    assert.deepEqual(pushes(), []);
});

test('a repository without the queue is read again only every quarter of an hour; one with it, every poll', async () => {
    /* Given */
    const {watch, repos, asked, now} = setup([session('s1', OTHER), session('s2', ROOT)]);
    repos.set('o/other', {queue: null});
    repos.set(REPO, {queue: queueOf([head(1)])});
    await watch.poll();
    asked.length = 0;

    /* When */
    now.value += MIN;
    await watch.poll();
    const aMinuteOn = asked.map(([path]) => path);
    asked.length = 0;
    now.value = NOW + QUEUE_RECHECK_MS;
    await watch.poll();
    const aQuarterOn = asked.map(([path]) => path);

    /* Then */
    assert.deepEqual(aMinuteOn, [ROOT]);
    assert.deepEqual(aQuarterOn, [OTHER, ROOT]);
});

test('a repository that stops using the queue, or that nothing runs in any more, is pushed once as null', async () => {
    /* Given */
    const sessions = [session('s1', ROOT)];
    const {watch, repos, pushes} = setup(sessions);
    repos.set(REPO, {queue: queueOf([head(1)])});
    await watch.poll();

    /* When */
    sessions.length = 0;
    await watch.poll();
    await watch.poll();

    /* Then */
    assert.deepEqual(
        pushes().map((change) => change.queue === null),
        [false, true],
    );
    assert.deepEqual(pushes()[1], {repository: REPO, queue: null, errands: []});
});

test('an unreachable GitHub keeps what was pushed last', async () => {
    /* Given */
    const {watch, repos, pushes} = setup([session('s1', ROOT)]);
    repos.set(REPO, {queue: queueOf([head(1)])});
    await watch.poll();

    /* When */
    repos.set(REPO, {queue: null, unavailable: true});
    await watch.poll();

    /* Then */
    assert.equal(pushes().length, 1);
});

test('my PR becoming the head, failing as the head or merging notifies nothing (#434)', async () => {
    /* Given */
    const {watch, repos, renderer, pushes} = setup([session('s1', ROOT, [1, 5])]);
    repos.set(REPO, {queue: queueOf([head(1), queued(5, 2), queued(6, 3)])});
    await watch.poll();

    /* When */
    repos.set(REPO, {queue: queueOf([failed(1), head(5), queued(6, 2)])});
    await watch.poll();
    repos.set(REPO, {queue: queueOf([failed(1), head(6)]), open: [1, 6]});
    await watch.poll();

    /* Then */
    assert.equal(pushes().length, 3);
    assert.deepEqual(renderer.only('statusUpdate'), []);
    assert.deepEqual(renderer.only('terminalNotification'), []);
    assert.deepEqual(renderer.only('sessionNeedsAttention'), []);
});

test('it polls on start, every minute and on focus; never once stopped', async () => {
    /* Given */
    const {watch, repos, asked, timers} = setup([session('s1', ROOT)]);
    repos.set(REPO, {queue: queueOf([head(1)])});

    /* When */
    watch.focused();
    await Promise.resolve();
    const beforeStart = asked.length;
    watch.start();
    await watch.poll();
    timers.tick();
    await watch.poll();
    watch.stop();
    watch.focused();

    /* Then */
    assert.equal(beforeStart, 0);
    assert.ok(asked.length >= 2);
    assert.equal(timers.pending, 0);
});
