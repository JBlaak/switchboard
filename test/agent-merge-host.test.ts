/**
 * The Merge manager on the agent (#438, #442): the Merge host driving a Merge
 * manager and fix errands that record what they are told, a real hook
 * forwarder, and sessions as a test sets them. Nothing here has a Mac
 * connected unless a test says so.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {HookForwarder} from '../src/application/services/agent-host/hook-forwarder';
import {MERGE_TICK_MS, MergeHost, type MergeHostDeps} from '../src/application/services/agent-host/merge-host';
import {EMPTY_LANE_STATE, type LaneState} from '../src/domain/agent/lane-state';
import type {AgentMessage, HostSettings} from '../src/domain/agent/protocol';
import type {AskedQuestions} from '../src/domain/questions/question';
import type {FixErrand} from '../src/domain/merge-manager/errands';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import type {LandedPullRequest} from '../src/domain/merge-manager/model';
import {linkPair} from './support/agent-link';
import {fakeTimers, silentLog} from './support/fakes';
import {NOW, landedPr} from './support/merge-manager-fixtures';

function errand(id: string, sessionId: string): FixErrand {
    return {
        id,
        key: 'movelab/connect#7',
        repository: 'movelab/connect',
        number: 7,
        branch: 'branch-7',
        lane: 'switchboard',
        cause: 'checks',
        headOid: 'oid-7',
        sessionId,
        currentId: sessionId,
        worktree: '/home/dev/projects/connect/.claude/worktrees/errand-7',
        startedAt: NOW,
        finished: null,
        stoppedAt: null,
    };
}

function harness({merging = true, state = EMPTY_LANE_STATE as LaneState} = {}) {
    const told: string[] = [];
    const settings: HostSettings = {instructions: '', copyConfig: true, baseFolder: '~/projects', mergingHost: merging};
    let landed: LandedPullRequest[] = [];
    let lane = state;
    const alive = new Set<string>();
    const exits: Array<(sessionId: string, code: number) => void> = [];
    const timers = fakeTimers();
    const hooks = new HookForwarder({
        endpoint: {url: 'http://127.0.0.1:4100', token: 'tok'},
        timers,
        ids: {newId: () => 'hook-1'},
        log: silentLog,
        stop: () => {},
        selfArchived: {read: () => null, write: () => {}},
        clock: {now: () => NOW},
    });
    const errandSessions = new Set(lane.errands.map((e) => e.currentId));
    const deps: MergeHostDeps = {
        manager: {
            poll: async () => void told.push('poll'),
            pause: async () => void told.push('pause'),
            resume: () => void told.push('resume'),
            adopt: (prs) => {
                landed = [...prs];
                told.push(`adopt ${prs.map((pr) => pr.number).join(',')}`);
            },
            all: () => landed,
            state: () => mergeManagerState(landed, new Map()),
            land: async (repository, number) => {
                told.push(`land ${repository}#${number}`);
                return {ok: false, reason: 'test'};
            },
            unland: async () => ({ok: true}),
        },
        errands: {
            errands: () => lane.errands,
            isErrand: (id) => errandSessions.has(id),
            handOver: () => {
                told.push('handOver');
                return [...errandSessions];
            },
            turnEnded: (ids) => void told.push(`turnEnded ${ids.join(',')}`),
            sessionEnded: (id) => void told.push(`sessionEnded ${id}`),
            needsAttention: (id, question) => void told.push(`needsAttention ${id}: ${question}`),
            tryAgain: async () => ({ok: true, sessionId: null}),
        },
        store: {
            current: () => lane,
            removeErrands: (ids) => {
                told.push(`forget ${ids.join(',')}`);
                lane = {...lane, errands: lane.errands.filter((e) => !ids.includes(e.id))};
            },
            byRepository: () => ({}),
            setNoWorkflowScope: (value) => void told.push(`noWorkflowScope ${value}`),
        },
        sessions: {
            isAlive: (id) => alive.has(id),
            onExit: (listener) => void exits.push(listener),
            stop: (id) => {
                told.push(`stop ${id}`);
                return true;
            },
        },
        hooks,
        hostSettings: () => settings,
        setMerging: (on) => {
            settings.mergingHost = on;
            told.push(`merging ${on}`);
        },
        timers,
        log: silentLog,
    };
    const merge = new MergeHost(deps);
    return {
        merge,
        told,
        settings,
        alive,
        hooks,
        timers,
        errandSessions,
        exit: (id: string) => exits.forEach((fn) => fn(id, 0)),
    };
}

const asked: AskedQuestions = {
    toolUseId: 'tu-1',
    questions: [{question: 'Keep the old snapshot?', header: 'Snapshot', options: [], multiSelect: false}],
    toolInput: {questions: []},
};

test('a VM that is not the Merging host reads and runs nothing', async () => {
    /* Given */
    const h = harness({merging: false});

    /* When */
    await h.merge.tick();

    /* Then */
    assert.deepEqual(h.told, ['pause']);
});

test('while it merges, every tick polls the lanes, every MERGE_TICK_MS', async () => {
    /* Given */
    const h = harness();
    const stop = h.merge.start();
    await new Promise((resolve) => setImmediate(resolve));

    /* When */
    h.timers.tick();
    await new Promise((resolve) => setImmediate(resolve));

    /* Then */
    assert.equal(h.told.filter((t) => t === 'poll').length, 2);
    assert.equal(MERGE_TICK_MS, 60_000);
    stop();
});

test('after a restart the errands that died with the agent are forgotten, so fresh ones start', async () => {
    /* Given */
    const h = harness({state: {...EMPTY_LANE_STATE, errands: [errand('a', 'gone'), errand('b', 'alive')]}});
    h.alive.add('alive');

    /* When */
    await h.merge.tick();

    /* Then */
    assert.deepEqual(h.told.slice(0, 3), ['forget a', 'resume', 'poll']);
});

test('the hand-off takes the landed PRs, makes this VM the Merging host and runs a pass', async () => {
    /* Given */
    const h = harness({merging: false});
    h.told.length = 0;

    /* When */
    await h.merge.call('take', {landed: [landedPr(7, 10), landedPr(8, 5)], noWorkflowScope: true});
    await h.merge.tick();

    /* Then */
    assert.deepEqual(h.told.slice(0, 4), ['handOver', 'noWorkflowScope true', 'adopt 7,8', 'merging true']);
    assert.ok(h.told.includes('poll'));
    assert.equal(h.merge.merging, true);
});

test('bring back finishes the step, stops the errands and answers the landed PRs', async () => {
    /* Given */
    const h = harness({state: {...EMPTY_LANE_STATE, errands: [errand('a', 'errand-1')]}});
    h.alive.add('errand-1');
    await h.merge.call('take', {landed: [landedPr(7, 10)]});
    h.told.length = 0;

    /* When */
    const answer = (await h.merge.call('release', {})) as {landed: LandedPullRequest[]};

    /* Then */
    assert.deepEqual(h.told, ['merging false', 'pause', 'handOver', 'stop errand-1']);
    assert.deepEqual(
        answer.landed.map((pr) => pr.number),
        [7],
    );
    assert.equal(h.merge.merging, false);
});

test('Land it from the Mac is run here while this VM merges, and refused when it does not', async () => {
    /* Given */
    const h = harness();
    const idle = harness({merging: false});

    /* When */
    await h.merge.call('land', {repository: 'movelab/connect', number: 9});
    const refused = await idle.merge.call('land', {repository: 'movelab/connect', number: 9}).catch((e: Error) => e);

    /* Then */
    assert.ok(h.told.includes('land movelab/connect#9'));
    assert.match(String(refused), /not the Merging host/);
});

test('an errand that asks a question stops with it, and no Mac is asked', () => {
    /* Given */
    const h = harness();
    h.errandSessions.add('errand-1');
    const replies: unknown[] = [];

    /* When */
    h.hooks.receiver.receive('errand-1', asked, (json) => void replies.push(json));

    /* Then */
    assert.ok(h.told.includes('needsAttention errand-1: Keep the old snapshot?'));
    assert.deepEqual(replies, [{}]);
});

test("errands' turn ends and session ends reach the errands, but not ones a shutdown ended", () => {
    /* Given */
    const h = harness();
    const stop = h.merge.start();

    /* When */
    h.hooks.archiveTool.turnEnded('errand-1');
    h.exit('errand-1');
    stop();
    h.exit('errand-2');

    /* Then */
    assert.ok(h.told.includes('turnEnded errand-1'));
    assert.ok(h.told.includes('sessionEnded errand-1'));
    assert.ok(!h.told.includes('sessionEnded errand-2'));
});

test('a call from the Mac is answered over its link', async () => {
    /* Given */
    const h = harness();
    const pair = linkPair();
    const received: AgentMessage[] = [];
    pair.mac.onMessage((message) => received.push(message));

    /* When */
    h.merge.handle(pair.agent, {type: 'merge-call', requestId: 'r1', method: 'state', args: {since: 0}});
    await new Promise((resolve) => setImmediate(resolve));

    /* Then */
    assert.equal(received[0]?.type, 'merge-answer');
    assert.equal(received[0]?.type === 'merge-answer' && received[0].ok, true);
});
