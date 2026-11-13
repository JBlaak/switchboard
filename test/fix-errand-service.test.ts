/**
 * Fix errands' service (#437) against fake ports: a Merge manager holding
 * landed PRs, GitHub as a test sets it, git and sessions that record what
 * they were asked, and an in-memory store.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FixErrandService} from '../src/application/services/fix-errand-service';
import type {FoldedLane} from '../src/application/services/merge-manager-service';
import type {FixErrandStore} from '../src/application/ports/fix-errand-store';
import type {GitHubWrite} from '../src/application/ports/github-cli';
import type {FixErrand} from '../src/domain/merge-manager/errands';
import {errandAllowRules} from '../src/domain/merge-manager/errands';
import type {LandedPullRequest, LanePullRequestRead, SetAside} from '../src/domain/merge-manager/model';
import {landedKey} from '../src/domain/merge-manager/model';
import type {SessionOptions} from '../src/domain/launch/session-options';
import type {PullRequestStatus} from '../src/domain/session-work/model';
import {QUEUE_LABELS} from '../src/domain/project/merge-queue';
import {silentLog} from './support/fakes';
import {NOW, REPO, landedPr, laneRead, prRead} from './support/merge-manager-fixtures';

const KEY = landedKey(REPO, 7);
const FIXING_CHECKS = {kind: 'fixing', cause: 'checks'} as const;
const RUN_URL = `https://github.com/${REPO}/actions/runs/555/job/1`;

class MemoryErrandStore implements FixErrandStore {
    public readonly rows = new Map<string, FixErrand>();
    public all(): FixErrand[] {
        return [...this.rows.values()].sort((a, b) => a.startedAt - b.startedAt);
    }
    public save(errand: FixErrand): void {
        this.rows.set(errand.id, errand);
    }
    public remove(ids: readonly string[]): void {
        for (const id of ids) this.rows.delete(id);
    }
}

function setup(landed: LandedPullRequest[], reads: LanePullRequestRead[]) {
    const prs = new Map(landed.map((pr) => [pr.key, pr]));
    const world: {reads: Map<number, LanePullRequestRead>; now: number; onPoll?: () => void} = {
        reads: new Map(reads.map((read) => [read.number, read])),
        now: NOW,
    };
    const asides: Array<{key: string; aside: SetAside | null}> = [];
    const links: Array<{key: string; sessionId: string | null}> = [];
    const started: Array<{sessionId: string; worktree: string; options: SessionOptions}> = [];
    const gitWrites: string[] = [];
    const github: string[] = [];
    const archived: string[] = [];
    const spared: string[] = [];
    let id = 0;
    const checks: PullRequestStatus['checks'] = [{name: 'Unit tests', state: 'failing', url: RUN_URL}];
    const ok: GitHubWrite = {ok: true};

    const service = new FixErrandService({
        store: new MemoryErrandStore(),
        manager: {
            pullRequest: (repository, number) => prs.get(landedKey(repository, number)) ?? null,
            setAside: (key, aside) => {
                asides.push({key, aside});
                const pr = prs.get(key);
                if (pr) prs.set(key, {...pr, setAside: aside});
                return prs.get(key) ?? null;
            },
            linkErrand: (key, sessionId) => {
                links.push({key, sessionId});
                return prs.get(key) ?? null;
            },
            poll: async () => world.onPoll?.(),
        },
        github: {
            laneRead: async (_repo, numbers) =>
                laneRead(numbers.map((n) => world.reads.get(n)).filter((r): r is LanePullRequestRead => !!r)),
            pullRequests: async (repository, numbers) =>
                numbers.map((number) => ({number, url: '', repository, closes: [], checks})),
            checkLogTail: async () => 'FAIL src/rocket.test.ts',
            rerunFailedJobs: async (_repo, runId) => {
                github.push(`rerun ${runId}`);
                return ok;
            },
            removeLabel: async (_repo, number, label) => {
                github.push(`remove ${label} from #${number}`);
                return ok;
            },
        },
        checkoutOf: async (repository) => (repository === REPO ? '/code/connect' : null),
        git: {
            fetchBranch: async (_root, branch) => {
                gitWrites.push(`fetch ${branch}`);
                return {ok: true};
            },
            addDetachedWorktree: async (_root, path, ref) => {
                gitWrites.push(`worktree add --detach ${path} ${ref}`);
                return {ok: true};
            },
        },
        sessions: {
            start: async (request) => {
                started.push(request);
                return {ok: true};
            },
        },
        archive: {
            request: (launchId) => {
                archived.push(launchId);
                return {ok: true, message: 'Archived when this turn ends.'};
            },
        },
        ids: {newId: () => `id-${String(++id).padStart(8, '0')}`},
        clock: {now: () => world.now},
        log: silentLog,
        runner: {spare: (key, headOid) => spared.push(`${key} at ${headOid}`)},
    });

    const lane = (kind: 'switchboard' | 'queue' = 'switchboard'): FoldedLane => ({
        repository: REPO,
        kind,
        read: laneRead([...world.reads.values()]),
        landed: [...prs.values()],
    });
    return {service, prs, world, asides, links, started, gitWrites, github, archived, spared, lane};
}

const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A world where #7, landed in a Switchboard lane, failed out on its checks and its errand started. */
async function withErrand(lane: 'switchboard' | 'queue' = 'switchboard') {
    const world = setup([landedPr(7, 10, lane, FIXING_CHECKS)], [prRead(7)]);
    world.service.laneRead(world.lane(lane));
    await settle();
    const sessionId = world.started[0].sessionId;
    world.asides.length = 0;
    return {...world, sessionId};
}

// ── Start ──

test('a head that failed out starts exactly one errand, in a worktree detached at its branch', async () => {
    /* Given */
    const {service, lane, started, gitWrites, links} = setup(
        [landedPr(7, 10, 'switchboard', FIXING_CHECKS)],
        [prRead(7)],
    );

    /* When */
    service.laneRead(lane());
    service.laneRead(lane());
    await settle();
    service.laneRead(lane());
    await settle();

    /* Then */
    assert.equal(started.length, 1);
    assert.deepEqual(gitWrites, [
        'fetch branch-7',
        'worktree add --detach /code/connect/.claude/worktrees/errand-7-id-00000 origin/branch-7',
    ]);
    assert.equal(started[0].worktree, '/code/connect/.claude/worktrees/errand-7-id-00000');
    assert.deepEqual(links, [{key: KEY, sessionId: started[0].sessionId}]);
});

test('nothing but a head at Fixing starts an errand', async () => {
    /* Given */
    const {service, lane, started} = setup(
        [
            landedPr(7, 10, 'switchboard', {kind: 'head', step: 'checks'}),
            landedPr(8, 9, 'switchboard', {kind: 'needsYou', reason: {kind: 'changes-requested'}}),
            landedPr(9, 8, 'switchboard', {kind: 'waiting', willConflict: true, position: null}),
        ],
        [prRead(7), prRead(8), prRead(9)],
    );

    /* When */
    service.laneRead(lane());
    await settle();

    /* Then */
    assert.equal(started.length, 0);
});

test("the errand runs in auto mode with allow rules for its branch only, on the failure's prompt", async () => {
    /* When */
    const {started} = await withErrand();

    /* Then */
    const {options} = started[0];
    assert.equal(options.permissionMode, 'auto');
    assert.deepEqual(options.allowedTools, errandAllowRules('branch-7'));
    assert.match(String(options.initialPrompt), /FAIL src\/rocket\.test\.ts/);
    assert.match(String(options.initialPrompt), /CI-LOG-BEGIN>>>\nUnit tests\n/);
});

test('an errand that cannot start (no local checkout) leaves the PR Needs you', async () => {
    /* Given */
    const world = setup([landedPr(7, 10, 'switchboard', FIXING_CHECKS, {repository: 'elsewhere/none'})], [prRead(7)]);

    /* When */
    world.service.laneRead(world.lane());
    await settle();

    /* Then */
    assert.equal(world.started.length, 0);
    assert.deepEqual(world.asides, [
        {key: KEY, aside: {kind: 'needsYou', cause: 'checks', reason: {kind: 'errand-stopped'}, headOid: 'oid-7'}},
    ]);
});

// ── Finish ──

test('pushed with a new head commit sends the PR back to its place', async () => {
    /* Given */
    const {service, sessionId, world, asides, archived} = await withErrand();
    world.reads.set(7, prRead(7, {headOid: 'oid-7-fixed'}));

    /* When */
    const answer = service.finish(sessionId, {outcome: 'pushed', note: 'fixed the flaky assertion'});
    await settle();

    /* Then */
    assert.equal(answer.ok, true);
    assert.deepEqual(archived, [sessionId]);
    assert.deepEqual(asides, [{key: KEY, aside: null}]);
});

test('pushed without the head moving leaves the PR Needs you', async () => {
    /* Given */
    const {service, sessionId, asides} = await withErrand();

    /* When */
    service.finish(sessionId, {outcome: 'pushed', note: 'pushed, I think'});
    await settle();

    /* Then */
    assert.deepEqual(
        asides.map(({aside}) => aside?.kind ?? null),
        ['needsYou'],
    );
});

test('retry in a Switchboard lane re-runs the failed run and sends the PR back', async () => {
    /* Given */
    const {service, sessionId, github, asides, spared} = await withErrand();

    /* When */
    service.finish(sessionId, {outcome: 'retry', note: 'runner died'});
    await settle();

    /* Then */
    assert.deepEqual(github, ['rerun 555']);
    assert.deepEqual(asides, [{key: KEY, aside: null}]);
    // The lane runner leaves the runs started again be while the PR waits behind the head.
    assert.deepEqual(spared, [`${KEY} at oid-7`]);
});

test('retry in a queue lane takes automerge:failed off', async () => {
    /* Given */
    const {service, sessionId, github} = await withErrand('queue');

    /* When */
    service.finish(sessionId, {outcome: 'retry', note: 'flaky'});
    await settle();

    /* Then */
    assert.deepEqual(github, [`remove ${QUEUE_LABELS.failed} from #7`]);
});

test('a session that is not an errand records nothing', () => {
    /* Given */
    const {service, archived} = setup([], []);

    /* When */
    const answer = service.finish('someone-else', {outcome: 'pushed', note: 'x'});

    /* Then */
    assert.equal(answer.ok, false);
    assert.deepEqual(archived, []);
});

// ── Stopped ──

test('a turn that ends without finish_errand leaves the PR Needs you', async () => {
    /* Given */
    const {service, sessionId, asides} = await withErrand();

    /* When */
    service.turnEnded([sessionId], false, sessionId);

    /* Then */
    assert.deepEqual(asides, [
        {key: KEY, aside: {kind: 'needsYou', cause: 'checks', reason: {kind: 'errand-stopped'}, headOid: 'oid-7'}},
    ]);
});

test('an errand blocked on a permission prompt leaves the PR Needs you', async () => {
    /* Given */
    const {service, sessionId, asides} = await withErrand();

    /* When */
    service.needsAttention(sessionId);

    /* Then */
    assert.deepEqual(
        asides.map(({aside}) => aside?.kind ?? null),
        ['needsYou'],
    );
});

test('the turn that called finish_errand ending does not stop it', async () => {
    /* Given */
    const {service, sessionId, world, asides} = await withErrand();
    world.reads.set(7, prRead(7, {headOid: 'oid-7-fixed'}));
    service.finish(sessionId, {outcome: 'pushed', note: 'done'});
    await settle();
    asides.length = 0;

    /* When */
    service.turnEnded([sessionId], true, sessionId);
    service.sessionEnded(sessionId);

    /* Then */
    assert.deepEqual(asides, []);
});

test('archiving a stopped errand by hand does not clear Needs you', async () => {
    /* Given */
    const {service, sessionId, asides} = await withErrand();
    service.turnEnded([sessionId], false, sessionId);
    asides.length = 0;

    /* When */
    service.sessionEnded(sessionId);

    /* Then */
    assert.deepEqual(asides, []);
});

test("a stopped errand's later finish_errand clears Needs you", async () => {
    /* Given */
    const {service, sessionId, world, asides} = await withErrand();
    service.turnEnded([sessionId], false, sessionId);
    world.reads.set(7, prRead(7, {headOid: 'oid-7-fixed'}));
    asides.length = 0;

    /* When */
    service.finish(sessionId, {outcome: 'pushed', note: 'after your answer'});
    await settle();

    /* Then */
    assert.deepEqual(asides, [{key: KEY, aside: null}]);
});

test('Try again starts a new errand with my note and what the last one said', async () => {
    /* Given */
    const {service, sessionId, prs, started} = await withErrand();
    service.finish(sessionId, {outcome: 'pushed', note: 'rewrote the fixture'});
    await settle();
    service.turnEnded([sessionId], false, sessionId);
    const pr = prs.get(KEY)!;
    prs.set(KEY, {...pr, stage: {kind: 'needsYou', reason: {kind: 'errand-stopped'}}});

    /* When */
    const answer = await service.tryAgain(REPO, 7, 'the snapshot changed on purpose');

    /* Then */
    assert.equal(answer.ok, true);
    assert.equal(started.length, 2);
    const prompt = String(started[1].options.initialPrompt);
    assert.match(prompt, /pushed a fix: rewrote the fixture/);
    assert.match(prompt, /the snapshot changed on purpose/);
});

test('a PR that fails out again after a finished errand gets a new one carrying its note', async () => {
    /* Given */
    const {service, sessionId, world, prs, started, lane} = await withErrand();
    service.finish(sessionId, {outcome: 'pushed', note: 'bumped the timeout'});
    world.reads.set(7, prRead(7, {headOid: 'oid-7-b'}));
    await settle();
    prs.set(KEY, {...prs.get(KEY)!, stage: FIXING_CHECKS});

    /* When */
    service.laneRead(lane());
    await settle();

    /* Then */
    assert.equal(started.length, 2);
    assert.match(String(started[1].options.initialPrompt), /pushed a fix: bumped the timeout/);
});

test('an errand is forgotten once its PR leaves the lane', async () => {
    /* Given */
    const {service, prs, lane} = await withErrand();
    prs.delete(KEY);

    /* When */
    service.laneRead(lane());

    /* Then */
    assert.deepEqual(service.errands(), []);
});

// ── Questions, Try again for any Needs you, and the hand-off (#442, #432 story 14) ──

test('an errand that asks a question leaves the PR Needs you with the question', async () => {
    /* Given */
    const {service, sessionId, asides} = await withErrand();

    /* When */
    service.needsAttention(sessionId, 'Keep the old snapshot or take the new one?');

    /* Then */
    assert.deepEqual(asides, [
        {
            key: KEY,
            aside: {
                kind: 'needsYou',
                cause: 'checks',
                reason: {kind: 'errand-stopped', question: 'Keep the old snapshot or take the new one?'},
                headOid: 'oid-7',
            },
        },
    ]);
});

test('Try again on review feedback reads the lane again, and says what GitHub still shows', async () => {
    /* Given */
    const needsYou = {kind: 'needsYou', reason: {kind: 'changes-requested'}} as const;
    const {service, started, world} = setup([landedPr(7, 10, 'switchboard', needsYou)], [prRead(7)]);
    let polled = 0;
    world.onPoll = () => void polled++;

    /* When */
    const answer = await service.tryAgain(REPO, 7, null);

    /* Then */
    assert.equal(polled, 1);
    assert.equal(started.length, 0);
    assert.deepEqual(answer, {
        ok: false,
        reason: 'GitHub still shows it: changes are requested. Push a change, and it goes back to its place by itself.',
    });
});

test('Try again on a refused merge takes its set-aside off and sends it back to its place', async () => {
    /* Given */
    const refused = {kind: 'needsYou', reason: {kind: 'merge-refused', reason: 'Base branch was modified'}} as const;
    const aside: SetAside = {kind: 'needsYou', cause: null, reason: refused.reason, headOid: 'oid-7'};
    const {service, prs, asides, world} = setup(
        [landedPr(7, 10, 'switchboard', refused, {setAside: aside})],
        [prRead(7)],
    );
    world.onPoll = () =>
        prs.set(KEY, {...prs.get(KEY)!, stage: {kind: 'waiting', willConflict: false, position: null}});

    /* When */
    const answer = await service.tryAgain(REPO, 7, null);

    /* Then */
    assert.deepEqual(asides, [{key: KEY, aside: null}]);
    assert.deepEqual(answer, {ok: true, sessionId: null});
});

test('Try again with a note on a refused merge that failed on its checks starts an errand with the note', async () => {
    /* Given */
    const refused = {kind: 'needsYou', reason: {kind: 'merge-refused', reason: 'Required check failed'}} as const;
    const aside: SetAside = {kind: 'needsYou', cause: 'checks', reason: refused.reason, headOid: 'oid-7'};
    const {service, started} = setup([landedPr(7, 10, 'switchboard', refused, {setAside: aside})], [prRead(7)]);

    /* When */
    const answer = await service.tryAgain(REPO, 7, 'the e2e job is flaky on macOS');

    /* Then */
    assert.equal(answer.ok, true);
    assert.match(String(started[0].options.initialPrompt), /the e2e job is flaky on macOS/);
});

test('a hand-off forgets the running errands, so stopping their sessions does not send the PR to Needs you', async () => {
    /* Given */
    const {service, sessionId, asides} = await withErrand();

    /* When */
    const handed = service.handOver();
    service.sessionEnded(sessionId);

    /* Then */
    assert.deepEqual(handed, [sessionId]);
    assert.deepEqual(service.errands(), []);
    assert.deepEqual(asides, []);
});
