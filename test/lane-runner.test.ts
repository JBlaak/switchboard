/**
 * The Switchboard lane runner (#435) driven by the Merge manager's poll,
 * against a fake GitHub that answers the lane read and records every write:
 * update, merge (405, 409, refusals), cancel, test rebase, lost approval and
 * stacks.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MergeManagerService} from '../src/application/services/merge-manager-service';
import {LaneRunner} from '../src/application/services/lane-runner';
import type {
    BranchUpdate,
    GitHubCli,
    LaneReads,
    LaneWrites,
    MergeAnswer,
    QueueLabelWrites,
} from '../src/application/ports/github-cli';
import type {LandedStore} from '../src/application/ports/landed-store';
import type {LaneSavings} from '../src/application/ports/lane-savings';
import type {TestRebaseAnswer} from '../src/application/ports/test-rebase';
import type {LandedPullRequest, LanePullRequestRead, LaneSaving} from '../src/domain/merge-manager/model';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {MIN, NOW, REPO, RULES, prRead} from './support/merge-manager-fixtures';

class MemoryLandedStore implements LandedStore {
    public readonly rows = new Map<string, LandedPullRequest>();
    public all(): LandedPullRequest[] {
        return [...this.rows.values()];
    }
    public apply(save: readonly LandedPullRequest[], remove: readonly string[]): void {
        for (const pr of save) this.rows.set(pr.key, pr);
        for (const key of remove) this.rows.delete(key);
    }
}

class MemorySavings implements LaneSavings {
    public readonly rows: {kind: LaneSaving; count: number}[] = [];
    public add(_repository: string, kind: LaneSaving, count: number): void {
        this.rows.push({kind, count});
    }
    public since(): Record<LaneSaving, number> {
        const totals = {'update-not-pushed': 0, 'run-cancelled': 0, 'conflict-found': 0};
        for (const row of this.rows) totals[row.kind] += row.count;
        return totals;
    }
    public byRepository(): Record<string, Record<LaneSaving, number>> {
        return {};
    }
}

interface World {
    prs: Record<number, LanePullRequestRead>;
    trunkOid: string;
    /** What the next merges answer, in turn; a merge with none left merges. */
    merges: (MergeAnswer | (() => MergeAnswer))[];
    /** What the next updates answer, in turn; an update with none left rebases the branch. */
    updates: BranchUpdate[];
    /** What a test rebase of each branch answers. */
    rebases: Record<string, TestRebaseAnswer>;
    now: number;
}

function setup(prs: LanePullRequestRead[], world: Partial<World> = {}) {
    const state: World = {
        prs: Object.fromEntries(prs.map((pr) => [pr.number, pr])),
        trunkOid: 'trunk-1',
        merges: [],
        updates: [],
        rebases: {},
        now: NOW,
        ...world,
    };
    const writes: string[] = [];
    const byId = (id: string) => Object.values(state.prs).find((pr) => pr.id === id);
    const github: Pick<GitHubCli, LaneReads | QueueLabelWrites | LaneWrites> = {
        queuedPullRequests: async () => [],
        workflowFiles: async () => [],
        queueEntries: async () => [],
        laneRead: async (repo, numbers) => ({
            repository: repo,
            viewer: 'joris',
            trunk: 'main',
            trunkOid: state.trunkOid,
            rules: RULES,
            mergeMethods: ['squash', 'merge'],
            pullRequests: numbers.map((number) => state.prs[number]).filter((pr) => pr !== undefined),
        }),
        addLabel: async () => ({ok: true}),
        removeLabel: async () => ({ok: true}),
        updateBranch: async (id, expected) => {
            const pr = byId(id)!;
            writes.push(`update #${pr.number} at ${expected}`);
            const answer = state.updates.shift();
            if (answer) return answer;
            state.prs[pr.number] = {
                ...pr,
                headOid: `${pr.headOid}+`,
                mergeState: 'blocked',
                checks: [{name: 'Unit tests', state: 'queued', startedAt: null}],
            };
            return {ok: true};
        },
        mergePullRequest: async (_repo, number, sha, method) => {
            writes.push(`merge #${number} at ${sha} by ${method}`);
            const answer = state.merges.shift();
            if (answer) return typeof answer === 'function' ? answer() : answer;
            state.prs[number] = {...state.prs[number], state: 'merged', mergedAt: new Date(state.now).toISOString()};
            state.trunkOid += '+';
            return {ok: true};
        },
        cancelRun: async (_repo, runId) => {
            writes.push(`cancel ${runId}`);
            return {ok: true};
        },
        forceCancelRun: async (_repo, runId) => {
            writes.push(`force-cancel ${runId}`);
            return {ok: true};
        },
        rerunFailedJobs: async (_repo, runId) => {
            writes.push(`rerun ${runId}`);
            return {ok: true};
        },
    };
    const rebased: string[] = [];
    const savings = new MemorySavings();
    const clock = {now: () => state.now};
    const runner = new LaneRunner({
        github,
        testRebase: {
            conflicts: async (_repo, _trunk, branch) => {
                rebased.push(branch);
                return state.rebases[branch] ?? {conflict: false, files: []};
            },
        },
        savings,
        clock,
        log: silentLog,
    });
    const service = new MergeManagerService({
        store: new MemoryLandedStore(),
        github,
        renderer: fakeRenderer(),
        clock,
        timers: fakeTimers(),
        log: silentLog,
        runner,
    });
    /** Poll, and every poll the runner asked for after it. */
    const pass = async () => {
        await service.poll();
        for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setImmediate(resolve));
            const running = (service as unknown as {polling: Promise<void> | null}).polling;
            if (running) await running;
        }
    };
    /** A pass, and the minute's read after it that shows what its writes did. */
    const settle = async () => {
        await pass();
        state.now += MIN;
        await pass();
    };
    const stage = (number: number) => service.pullRequest(REPO, number)?.stage;
    const land = async (...numbers: number[]) => {
        for (const number of numbers) {
            await service.land(REPO, number);
            state.now += MIN;
        }
    };
    return {state, service, runner, writes, rebased, savings, settle, stage, land};
}

test('only the head is updated, pinned to its head commit; nothing waiting is pushed', async () => {
    /* Given */
    const {land, settle, writes, stage} = setup([prRead(1, {mergeState: 'behind'}), prRead(2, {mergeState: 'behind'})]);
    await land(1, 2);

    /* When */
    await settle();

    /* Then */
    assert.deepEqual(writes, ['update #1 at oid-1']);
    assert.deepEqual(stage(1), {kind: 'head', step: 'checks'});
    assert.equal(stage(2)?.kind, 'waiting');
});

test('a green head merges with the first allowed method, and the next PR becomes the head', async () => {
    /* Given */
    const {land, settle, writes, stage} = setup([prRead(1), prRead(2, {mergeState: 'behind'})]);
    await land(1, 2);

    /* When */
    await settle();

    /* Then */
    assert.deepEqual(writes, ['merge #1 at oid-1 by squash', 'update #2 at oid-2']);
    assert.equal(stage(1)?.kind, 'merged');
    assert.deepEqual(stage(2), {kind: 'head', step: 'checks'});
});

test('a 405 on merge updates the head again, never leaving it stuck', async () => {
    /* Given */
    const {land, settle, writes, stage} = setup([prRead(1)], {
        merges: [{ok: false, status: 405, reason: 'Pull Request is not mergeable'}],
    });
    await land(1);

    /* When */
    await settle();

    /* Then */
    assert.deepEqual(writes, ['merge #1 at oid-1 by squash', 'update #1 at oid-1']);
    assert.deepEqual(stage(1), {kind: 'head', step: 'checks'});
});

test('a 409 on merge reads the lane again and merges the head at its new commit', async () => {
    /* Given */
    const {land, settle, writes, state, stage} = setup([prRead(1)]);
    await land(1);
    state.merges = [
        () => {
            // A push to the head between the read and the merge, green again.
            state.prs[1] = {...state.prs[1], headOid: 'oid-1b'};
            return {ok: false, status: 409, reason: 'Head branch was modified'};
        },
    ];

    /* When */
    await settle();

    /* Then */
    assert.deepEqual(writes, ['merge #1 at oid-1 by squash', 'merge #1 at oid-1b by squash']);
    assert.equal(stage(1)?.kind, 'merged');
});

test('an update that conflicts sets the head aside as Fixing and the next PR becomes the head', async () => {
    /* Given */
    const {land, settle, writes, stage} = setup(
        [prRead(1, {mergeState: 'behind'}), prRead(2, {mergeState: 'behind'})],
        {updates: [{ok: false, why: 'conflict', reason: 'Cannot update PR branch due to conflicts'}]},
    );
    await land(1, 2);

    /* When */
    await settle();

    /* Then */
    assert.deepEqual(writes, ['update #1 at oid-1', 'update #2 at oid-2']);
    assert.deepEqual(stage(1), {kind: 'fixing', cause: 'conflict'});
    assert.deepEqual(stage(2), {kind: 'head', step: 'checks'});
});

test('a failed required check on an up-to-date head is Fixing, and the next PR becomes the head', async () => {
    /* Given */
    const {land, settle, stage} = setup([
        prRead(1, {checks: [{name: 'Unit tests', state: 'failed', startedAt: NOW}]}),
        prRead(2, {mergeState: 'behind'}),
    ]);
    await land(1, 2);

    /* When */
    await settle();

    /* Then */
    assert.deepEqual(stage(1), {kind: 'fixing', cause: 'checks'});
    assert.deepEqual(stage(2), {kind: 'head', step: 'checks'});
});

test('a merge GitHub refuses for an unknown reason puts the head in Needs you', async () => {
    /* Given */
    const {land, settle, stage} = setup([prRead(1)], {
        merges: [{ok: false, status: 422, reason: 'Repository rule violations found'}],
    });
    await land(1);

    /* When */
    await settle();

    /* Then */
    assert.deepEqual(stage(1), {
        kind: 'needsYou',
        reason: {kind: 'merge-refused', reason: 'Repository rule violations found'},
    });
});

test('approved PRs waiting behind the head have their unfinished runs cancelled, and it counts as saved', async () => {
    /* Given */
    const {land, settle, writes, savings, state} = setup([
        prRead(1, {checks: [{name: 'Unit tests', state: 'running', startedAt: NOW}]}),
        prRead(2, {runs: [{id: 21, state: 'unfinished'}]}),
        prRead(3, {review: 'review_required', approvedBy: [], runs: [{id: 31, state: 'unfinished'}]}),
    ]);
    await land(1, 2, 3);

    /* When */
    await settle();
    state.now += 3 * MIN;
    await settle();

    /* Then */
    assert.deepEqual(writes, ['cancel 21', 'force-cancel 21']);
    assert.equal(savings.since()['run-cancelled'], 1);
});

test('a waiting PR GitHub calls dirty is test-rebased and flagged, without a push', async () => {
    /* Given */
    const {land, settle, writes, rebased, stage, savings} = setup(
        [
            prRead(1, {checks: [{name: 'Unit tests', state: 'running', startedAt: NOW}]}),
            prRead(2, {mergeState: 'dirty', headRef: 'conflicting'}),
            prRead(3, {mergeState: 'dirty', headRef: 'only-a-merge-conflict'}),
        ],
        {rebases: {conflicting: {conflict: true, files: ['src/a.ts']}}},
    );
    await land(1, 2, 3);

    /* When */
    await settle();
    await settle();

    /* Then */
    assert.deepEqual(writes, []);
    assert.deepEqual(rebased, ['conflicting', 'only-a-merge-conflict']);
    assert.deepEqual(stage(2), {kind: 'waiting', willConflict: true, position: null});
    assert.deepEqual(stage(3), {kind: 'waiting', willConflict: false, position: null});
    assert.equal(savings.since()['conflict-found'], 1);
});

test('a head that loses its approval drops back to Held, and is not updated or merged', async () => {
    /* Given */
    const {land, settle, writes, stage, state} = setup([
        prRead(1, {checks: [{name: 'Unit tests', state: 'running', startedAt: NOW}]}),
        prRead(2, {checks: [{name: 'Unit tests', state: 'running', startedAt: NOW}]}),
    ]);
    await land(1, 2);
    await settle();

    /* When */
    state.prs[1] = {...state.prs[1], review: 'review_required', approvedBy: [], mergeState: 'blocked'};
    await settle();

    /* Then */
    assert.deepEqual(stage(1), {kind: 'held', reason: {kind: 'approval'}});
    assert.equal(stage(2)?.kind, 'head');
    assert.deepEqual(writes, []);
});

test('a stacked PR waits for its base, and once retargeted is not pushed until it is the head', async () => {
    /* Given */
    const {land, settle, writes, stage, state} = setup([
        prRead(1, {checks: [{name: 'Unit tests', state: 'running', startedAt: NOW}]}),
        prRead(2, {baseRef: 'branch-1', mergeState: 'behind'}),
    ]);
    await land(1, 2);
    await settle();
    assert.deepEqual(stage(2), {kind: 'held', reason: {kind: 'base', base: 'branch-1'}});

    /* When */
    state.prs[1] = {...state.prs[1], checks: [{name: 'Unit tests', state: 'passed', startedAt: NOW}]};
    // GitHub retargets #2 onto the trunk once #1 merged.
    const merged = {...state.prs[2], baseRef: 'main'};
    state.merges = [];
    await settle();
    state.prs[2] = merged;
    await settle();

    /* Then */
    assert.deepEqual(writes, ['merge #1 at oid-1 by squash', 'update #2 at oid-2']);
    assert.equal(stage(1)?.kind, 'merged');
    assert.deepEqual(stage(2), {kind: 'head', step: 'checks'});
});

test('when the trunk moves, the PRs waiting behind the head count as updates not pushed', async () => {
    /* Given */
    const {land, settle, savings, state} = setup([
        prRead(1, {checks: [{name: 'Unit tests', state: 'running', startedAt: NOW}]}),
        prRead(2),
        prRead(3),
    ]);
    await land(1, 2, 3);
    await settle();

    /* When */
    state.trunkOid = 'trunk-2';
    await settle();

    /* Then */
    assert.equal(savings.since()['update-not-pushed'], 2);
});
