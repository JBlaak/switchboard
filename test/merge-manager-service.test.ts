/**
 * The Merge manager's service (#434) against fake ports: GitHub as edited
 * between polls (workflows, PRs, label writes), an in-memory store, a fake
 * clock and timers.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    LANE_KIND_RECHECK_MS,
    MERGE_MANAGER_INTERVAL_MS,
    MergeManagerService,
    type MergeManagerServiceDeps,
} from '../src/application/services/merge-manager-service';
import type {GitHubCli, GitHubWrite, LaneReads, QueueLabelWrites} from '../src/application/ports/github-cli';
import type {LandedStore} from '../src/application/ports/landed-store';
import type {LandedPullRequest, LanePullRequestRead, MergeManagerState} from '../src/domain/merge-manager/model';
import {QUEUE_LABELS} from '../src/domain/project/merge-queue';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {MIN, NOW, REPO, RULES, prRead} from './support/merge-manager-fixtures';

const QUEUE_REPO = 'movelab/queued';
const QUEUE_WORKFLOW = [{name: 'merge_queue.yml', text: '      - uses: MoveLab-Studio/merge-queue@v1\n'}];

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

interface World {
    /** Each repository's PRs by number. */
    prs: Record<string, Record<number, LanePullRequestRead>>;
    /** Repositories with the queue Action in their workflows. */
    queueRepos: Set<string>;
    /** Repositories GitHub cannot be asked about. */
    unreachable: Set<string>;
    /** Repositories whose label writes GitHub refuses. */
    refused: Set<string>;
    now: number;
}

function setup(
    world: Partial<World> = {},
    store = new MemoryLandedStore(),
    runner?: MergeManagerServiceDeps['runner'],
) {
    const state: World = {
        prs: {},
        queueRepos: new Set([QUEUE_REPO]),
        unreachable: new Set(),
        refused: new Set(),
        now: NOW,
        ...world,
    };
    const calls: string[] = [];
    const labelled = (repo: string, number: number, change: (labels: string[]) => string[]): GitHubWrite => {
        const pr = state.prs[repo]?.[number];
        if (!pr || state.refused.has(repo)) return {ok: false, reason: 'Must have admin rights to Repository.'};
        state.prs[repo][number] = {...pr, labels: change([...pr.labels])};
        return {ok: true};
    };
    const github: Pick<GitHubCli, LaneReads | QueueLabelWrites> = {
        queuedPullRequests: async () => {
            calls.push('queued');
            return Object.entries(state.prs).flatMap(([repository, prs]) =>
                Object.values(prs)
                    .filter((pr) => pr.state === 'open' && pr.labels.some((label) => label.startsWith('automerge:')))
                    .map((pr) => ({repository, number: pr.number})),
            );
        },
        laneRead: async (repo, numbers) => {
            calls.push(`lane ${repo} ${[...numbers].sort((a, b) => a - b).join(',')}`);
            if (state.unreachable.has(repo)) return null;
            const prs = numbers.map((number) => state.prs[repo]?.[number]).filter((pr) => pr !== undefined);
            return {
                repository: repo,
                viewer: 'joris',
                trunk: 'main',
                trunkOid: 't',
                rules: RULES,
                mergeMethods: ['squash'],
                pullRequests: prs,
            };
        },
        workflowFiles: async (repo) => {
            calls.push(`workflows ${repo}`);
            if (state.unreachable.has(repo)) return null;
            return state.queueRepos.has(repo) ? QUEUE_WORKFLOW : [];
        },
        addLabel: async (repo, number, label) => {
            calls.push(`add ${repo}#${number} ${label}`);
            return labelled(repo, number, (labels) => [...labels, label]);
        },
        removeLabel: async (repo, number, label) => {
            calls.push(`remove ${repo}#${number} ${label}`);
            return labelled(repo, number, (labels) => labels.filter((name) => name !== label));
        },
    };
    const renderer = fakeRenderer();
    const timers = fakeTimers();
    const service = new MergeManagerService({
        store,
        github,
        renderer,
        clock: {now: () => state.now},
        timers,
        log: silentLog,
        ...(runner ? {runner} : {}),
    });
    const pushes = () => renderer.only('mergeManagerChanged').map((event) => event[1] as MergeManagerState);
    const stages = () =>
        Object.fromEntries(
            service.state().lanes.flatMap((lane) => lane.pullRequests.map((pr) => [pr.key, pr.stage.kind])),
        );
    const writes = () => calls.filter((call) => call.startsWith('add') || call.startsWith('remove'));
    return {state, service, store, calls, writes, pushes, stages, timers};
}

function inQueue(number: number, overrides: Partial<LanePullRequestRead> = {}): LanePullRequestRead {
    return prRead(number, {
        repository: QUEUE_REPO,
        url: `https://github.com/${QUEUE_REPO}/pull/${number}`,
        ...overrides,
    });
}

// ── Land and Unland ──

test('landing in a queue lane adds the opt-in label and takes autorebase off', async () => {
    /* Given */
    const {service, writes} = setup({prs: {[QUEUE_REPO]: {7: inQueue(7, {labels: [QUEUE_LABELS.rebaseOptIn]})}}});

    /* When */
    const result = await service.land(QUEUE_REPO, 7);

    /* Then */
    assert.equal(result.ok, true);
    assert.deepEqual(writes(), [
        `add ${QUEUE_REPO}#7 ${QUEUE_LABELS.optIn}`,
        `remove ${QUEUE_REPO}#7 ${QUEUE_LABELS.rebaseOptIn}`,
    ]);
    assert.equal(service.pullRequest(QUEUE_REPO, 7)?.lane, 'queue');
});

test('landing in a Switchboard lane writes nothing on GitHub, and answers its place in the lane', async () => {
    /* Given */
    const {service, writes, state} = setup({prs: {[REPO]: {1: prRead(1), 2: prRead(2)}}});
    await service.land(REPO, 1);
    state.now += MIN;

    /* When */
    const result = await service.land(REPO, 2);

    /* Then */
    assert.deepEqual(writes(), []);
    assert.equal(result.ok && result.landed.place, 2);
    assert.equal(result.ok && result.landed.lane, 'switchboard');
});

test('a draft, a teammate’s PR or a closed PR does not land, and nothing is written', async () => {
    /* Given */
    const {service, writes} = setup({
        prs: {
            [QUEUE_REPO]: {
                1: inQueue(1, {draft: true}),
                2: inQueue(2, {author: 'ben'}),
                3: inQueue(3, {state: 'closed'}),
            },
        },
    });

    /* When */
    const results = [
        await service.land(QUEUE_REPO, 1),
        await service.land(QUEUE_REPO, 2),
        await service.land(QUEUE_REPO, 3),
    ];

    /* Then */
    assert.deepEqual(
        results.map((result) => (result.ok ? 'landed' : result.reason)),
        ['Mark it ready for review first', 'Only your own pull requests land', '#3 is closed'],
    );
    assert.deepEqual(writes(), []);
    assert.deepEqual(service.state().lanes, []);
});

test('a label GitHub refuses fails the landing, which then lands nothing', async () => {
    /* Given */
    const {service} = setup({prs: {[QUEUE_REPO]: {7: inQueue(7)}}, refused: new Set([QUEUE_REPO])});

    /* When */
    const result = await service.land(QUEUE_REPO, 7);

    /* Then */
    assert.deepEqual(result, {ok: false, reason: 'Must have admin rights to Repository.'});
    assert.equal(service.pullRequest(QUEUE_REPO, 7), null);
});

test('unlanding in a queue lane takes the queue labels off; in a Switchboard lane it writes nothing', async () => {
    /* Given */
    const {service, writes} = setup({
        prs: {
            [QUEUE_REPO]: {7: inQueue(7, {labels: [QUEUE_LABELS.optIn, QUEUE_LABELS.next]})},
            [REPO]: {1: prRead(1)},
        },
    });
    await service.poll();
    await service.land(REPO, 1);

    /* When */
    const queue = await service.unland(QUEUE_REPO, 7);
    const switchboard = await service.unland(REPO, 1);

    /* Then */
    assert.deepEqual([queue, switchboard], [{ok: true}, {ok: true}]);
    assert.deepEqual(writes(), [
        `remove ${QUEUE_REPO}#7 ${QUEUE_LABELS.optIn}`,
        `remove ${QUEUE_REPO}#7 ${QUEUE_LABELS.next}`,
    ]);
    assert.deepEqual(service.state().lanes, []);
});

test('unlanding the Switchboard head hands the head to the next PR', async () => {
    /* Given */
    const {service, state, stages} = setup({prs: {[REPO]: {1: prRead(1), 2: prRead(2)}}});
    await service.land(REPO, 1);
    state.now += MIN;
    await service.land(REPO, 2);

    /* When */
    await service.unland(REPO, 1);
    await service.poll();

    /* Then */
    assert.deepEqual(stages(), {'movelab/connect#2': 'head'});
});

// ── Polling ──

test('my PRs carrying a queue label are landed by a poll, however they got it; one in a Switchboard lane is not', async () => {
    /* Given */
    const {service, stages} = setup({
        prs: {
            [QUEUE_REPO]: {
                7: inQueue(7, {
                    labels: [QUEUE_LABELS.optIn],
                    automerge: {state: 'pending', description: 'Number 2 in the merge queue'},
                }),
            },
            [REPO]: {1: prRead(1, {labels: [QUEUE_LABELS.optIn]})},
        },
    });

    /* When */
    await service.poll();

    /* Then */
    assert.deepEqual(stages(), {'movelab/queued#7': 'waiting'});
    assert.equal(service.state().lanes[0].pullRequests[0].place, 2);
});

test('a queue repository with no labelled PR is still a queue lane: landing there adds the label', async () => {
    /* Given */
    const {service, writes} = setup({prs: {[QUEUE_REPO]: {7: inQueue(7)}}});
    await service.poll();

    /* When */
    await service.land(QUEUE_REPO, 7);

    /* Then */
    assert.deepEqual(writes(), [`add ${QUEUE_REPO}#7 ${QUEUE_LABELS.optIn}`]);
});

test('landed PRs survive a restart, landed time and stage included', async () => {
    /* Given */
    const first = setup({prs: {[REPO]: {1: prRead(1), 2: prRead(2)}}});
    await first.service.land(REPO, 1);
    first.state.now += MIN;
    await first.service.land(REPO, 2);

    /* When */
    const again = setup({prs: first.state.prs, now: first.state.now}, first.store);

    /* Then: what a read said beyond the stage (the page's facts) comes with the next read */
    const kept = (state: MergeManagerState) =>
        state.lanes.map((lane) => ({...lane, pullRequests: lane.pullRequests.map(({facts: _facts, ...pr}) => pr)}));
    assert.deepEqual(kept(again.service.state()), kept(first.service.state()));
    assert.equal(again.service.pullRequest(REPO, 1)?.landedAt, NOW);
});

test('a landed PR closed without merging unlands itself on the next poll', async () => {
    /* Given */
    const {service, state, store} = setup({prs: {[REPO]: {1: prRead(1)}}});
    await service.land(REPO, 1);

    /* When */
    state.prs[REPO][1] = prRead(1, {state: 'closed'});
    await service.poll();

    /* Then */
    assert.equal(service.pullRequest(REPO, 1), null);
    assert.equal(store.rows.size, 0);
});

test('a merged PR is kept merged and not read again, then goes after a week', async () => {
    /* Given */
    const {service, state, calls, stages} = setup({prs: {[REPO]: {1: prRead(1)}}});
    await service.land(REPO, 1);
    state.prs[REPO][1] = prRead(1, {state: 'merged', mergedAt: new Date(NOW).toISOString()});
    await service.poll();
    calls.length = 0;

    /* When */
    await service.poll();
    const kept = stages();
    state.now += 7 * 24 * 60 * MIN;
    await service.poll();

    /* Then */
    assert.deepEqual(kept, {'movelab/connect#1': 'merged'});
    assert.deepEqual(calls, ['queued', 'queued']);
    assert.deepEqual(service.state().lanes, []);
});

test('a lane GitHub cannot be read keeps what it had', async () => {
    /* Given */
    const {service, state, stages} = setup({prs: {[REPO]: {1: prRead(1)}}});
    await service.land(REPO, 1);
    const before = stages();

    /* When */
    state.prs[REPO][1] = prRead(1, {state: 'closed'});
    state.unreachable.add(REPO);
    await service.poll();

    /* Then */
    assert.deepEqual(stages(), before);
});

test('the lane kind is read once a quarter of an hour, and the last one stands when it cannot be read', async () => {
    /* Given */
    const {service, state, calls} = setup();
    await service.laneKind(QUEUE_REPO);

    /* When */
    state.now += LANE_KIND_RECHECK_MS - 1;
    const cached = await service.laneKind(QUEUE_REPO);
    state.now += 1;
    state.unreachable.add(QUEUE_REPO);
    state.unreachable.add('movelab/other');
    const stale = await service.laneKind(QUEUE_REPO);
    const unknown = await service.laneKind('movelab/other');

    /* Then */
    assert.deepEqual([cached, stale, unknown], ['queue', 'queue', null]);
    assert.deepEqual(
        calls.filter((call) => call.startsWith('workflows')),
        [`workflows ${QUEUE_REPO}`, `workflows ${QUEUE_REPO}`, 'workflows movelab/other'],
    );
});

test('only the landed PRs are read, one request per repository', async () => {
    /* Given */
    const {service, calls} = setup({prs: {[REPO]: {1: prRead(1), 2: prRead(2), 3: prRead(3)}}});
    await service.land(REPO, 1);
    await service.land(REPO, 3);
    calls.length = 0;

    /* When */
    await service.poll();

    /* Then */
    assert.deepEqual(calls, ['queued', `lane ${REPO} 1,3`]);
});

test('the state is pushed when it changed, with the PRs that need me counted, and not when it did not', async () => {
    /* Given */
    const {service, state, pushes} = setup({prs: {[REPO]: {1: prRead(1)}}});
    await service.land(REPO, 1);
    await service.poll();
    const before = pushes().length;

    /* When */
    state.prs[REPO][1] = prRead(1, {review: 'changes_requested'});
    await service.poll();
    await service.poll();

    /* Then */
    assert.equal(pushes().length, before + 1);
    assert.equal(pushes().at(-1)?.needsYou, 1);
});

test('a set-aside holds on its commit and the errand link is kept', async () => {
    /* Given */
    const {service, stages} = setup({prs: {[REPO]: {1: prRead(1)}}});
    await service.land(REPO, 1);
    const key = 'movelab/connect#1';

    /* When */
    service.setAside(key, {kind: 'needsYou', cause: null, reason: {kind: 'errand-stopped'}, headOid: 'oid-1'});
    service.linkErrand(key, 'errand-session');
    await service.poll();

    /* Then */
    assert.deepEqual(stages(), {[key]: 'needsYou'});
    assert.equal(service.pullRequest(REPO, 1)?.errand, 'errand-session');
    assert.equal(service.setAside('movelab/other#1', null), null);
});

test('it polls on start, every minute and on focus; never once stopped', async () => {
    /* Given */
    const {service, calls, timers} = setup();
    const polls = () => calls.filter((call) => call === 'queued').length;

    /* When */
    service.focused();
    await new Promise((resolve) => setImmediate(resolve));
    const beforeStart = polls();
    service.start();
    await new Promise((resolve) => setImmediate(resolve));
    timers.tick();
    await new Promise((resolve) => setImmediate(resolve));
    service.focused();
    await new Promise((resolve) => setImmediate(resolve));
    service.stop();
    timers.tick();
    await new Promise((resolve) => setImmediate(resolve));

    /* Then */
    assert.equal(MERGE_MANAGER_INTERVAL_MS, 60_000);
    assert.equal(beforeStart, 0);
    assert.equal(polls(), 3);
    assert.equal(timers.pending, 0);
});

// ── For the fix errands (#437) ──

test('each lane read, once folded in, goes to whoever follows the lanes', async () => {
    /* Given */
    const {service} = setup({prs: {[REPO]: {7: prRead(7, {mergeState: 'dirty'})}}});
    await service.land(REPO, 7);
    const heard: Array<{repository: string; stages: string[]}> = [];
    service.onLaneRead((lane) =>
        heard.push({repository: lane.repository, stages: lane.landed.map((pr) => pr.stage.kind)}),
    );

    /* When */
    await service.poll();

    /* Then */
    assert.deepEqual(heard, [{repository: REPO, stages: ['fixing']}]);
});

// ── What it tells (#440) ──

test('a PR going to Needs you is told once, however many polls it stays there', async () => {
    /* Given */
    const {service, state} = setup({prs: {[REPO]: {1: prRead(1)}}});
    await service.land(REPO, 1);
    const told: string[][] = [];
    service.onTransitions((transitions) => told.push(transitions.needsYou.map((pr) => pr.key)));

    /* When */
    state.prs[REPO][1] = prRead(1, {review: 'changes_requested'});
    await service.poll();
    await service.poll();

    /* Then */
    assert.deepEqual(told, [['movelab/connect#1']]);
});

test('a PR merging is told once, with the PR', async () => {
    /* Given */
    const {service, state} = setup({prs: {[REPO]: {1: prRead(1)}}});
    await service.land(REPO, 1);
    const merged: number[][] = [];
    service.onTransitions((transitions) => merged.push(transitions.merged.map((pr) => pr.number)));

    /* When */
    state.prs[REPO][1] = prRead(1, {state: 'merged', mergedAt: new Date(NOW).toISOString()});
    await service.poll();
    await service.poll();

    /* Then */
    assert.deepEqual(merged, [[1]]);
});

test('PRs already in Needs you when the app starts are not told again', async () => {
    /* Given */
    const store = new MemoryLandedStore();
    const first = setup({prs: {[REPO]: {1: prRead(1, {review: 'changes_requested'})}}}, store);
    await first.service.land(REPO, 1);
    const {service} = setup({prs: {[REPO]: {1: prRead(1, {review: 'changes_requested'})}}}, store);
    let told = 0;
    service.onTransitions(() => told++);

    /* When */
    await service.poll();

    /* Then */
    assert.equal(told, 0);
});

test('a merge the lane runner had refused sends its PR to Needs you, and that is told in the same poll', async () => {
    /* Given */
    let refused = false;
    const runner: MergeManagerServiceDeps['runner'] = {
        conflicts: () => new Map(),
        run: async (read) => {
            if (refused) return {asides: [], conflictsChanged: false, reread: false};
            refused = true;
            const reason = {kind: 'merge-refused' as const, reason: 'Repository rule violations found'};
            return {
                asides: read.pullRequests.map((pr) => ({
                    key: `${REPO}#${pr.number}`,
                    aside: {kind: 'needsYou' as const, cause: null, reason, headOid: pr.headOid},
                })),
                conflictsChanged: false,
                reread: false,
            };
        },
    };
    const {service} = setup({prs: {[REPO]: {1: prRead(1)}}}, new MemoryLandedStore(), runner);
    await service.land(REPO, 1);
    const told: string[][] = [];
    service.onTransitions((transitions) => told.push(transitions.needsYou.map((pr) => pr.key)));

    /* When */
    await service.poll();

    /* Then */
    assert.deepEqual(told, [['movelab/connect#1']]);
});

test('a fix errand that stopped sends its PR to Needs you, and that is told on the next poll', async () => {
    /* Given */
    const {service} = setup({prs: {[REPO]: {1: prRead(1)}}});
    await service.land(REPO, 1);
    const told: string[][] = [];
    service.onTransitions((transitions) => told.push(transitions.needsYou.map((pr) => pr.key)));

    /* When */
    service.setAside('movelab/connect#1', {
        kind: 'needsYou',
        cause: 'checks',
        reason: {kind: 'errand-stopped'},
        headOid: 'oid-1',
    });
    await service.poll();

    /* Then */
    assert.deepEqual(told, [['movelab/connect#1']]);
});

// ── What the page shows besides (#439) ──

test("other people's PRs in a queue lane are never shown, only mine", async () => {
    /* Given */
    const {service} = setup({
        prs: {
            [QUEUE_REPO]: {
                7: inQueue(7, {
                    labels: [QUEUE_LABELS.optIn],
                    automerge: {state: 'pending', description: 'Number 3 in the merge queue'},
                }),
                8: inQueue(8, {
                    author: 'sam',
                    labels: [QUEUE_LABELS.optIn],
                    automerge: {state: 'pending', description: 'Number 2 in the merge queue'},
                }),
                9: inQueue(9, {
                    author: 'ana',
                    labels: [QUEUE_LABELS.optIn],
                    automerge: {state: 'pending', description: 'First in the merge queue'},
                }),
            },
        },
    });

    /* When */
    await service.poll();

    /* Then */
    const {lanes} = service.state();
    assert.deepEqual(
        lanes.map((lane) => [lane.repository, lane.pullRequests.map((pr) => pr.number)]),
        [[QUEUE_REPO, [7]]],
    );
    assert.deepEqual(Object.keys(lanes[0]).sort(), ['approvalLostOnPush', 'kind', 'pullRequests', 'repository']);
});

test('a landed PR carries who approved it and how its required checks stand', async () => {
    /* Given */
    const {service} = setup({
        prs: {
            [REPO]: {
                1: prRead(1, {
                    approvedBy: ['ana'],
                    checks: [{name: 'Unit tests', state: 'running', startedAt: NOW - MIN}],
                }),
            },
        },
    });

    /* When */
    await service.land(REPO, 1);

    /* Then */
    assert.deepEqual(service.state().lanes[0].pullRequests[0].facts, {
        approvedBy: ['ana'],
        checks: [{name: 'Unit tests', state: 'running'}],
    });
});
