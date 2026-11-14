/**
 * The Mac's Merging host (#442) against fakes: a local Merge manager that
 * records what it is told, a VM link that answers as a test sets it, and the
 * record kept in memory.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MergingHostService, type MergingLink} from '../src/application/services/merging-host-service';
import {MAC_HOST, handedOff, type MergingHostRecord} from '../src/domain/merge-manager/merging-host';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import type {LandedPullRequest, MergeManagerState} from '../src/domain/merge-manager/model';
import type {MergeCallMethod} from '../src/domain/agent/protocol';
import type {LandedTransitions} from '../src/domain/merge-manager/transitions';
import {fakeTimers, silentLog} from './support/fakes';
import {NOW, landedPr} from './support/merge-manager-fixtures';

const DEVBOX = {key: 'dev@devbox:22', name: 'devbox'};
const LOGGED_IN = "✓ Logged in to github.com account joris\n  - Token scopes: 'repo', 'workflow'";
const WAITING = {kind: 'waiting', willConflict: false, position: null} as const;

function setup({record = MAC_HOST, gh = LOGGED_IN, ghCode = 0, reachable = true} = {}) {
    const told: string[] = [];
    let landed: LandedPullRequest[] = [landedPr(1, 10, 'switchboard', WAITING)];
    const calls: Array<{method: MergeCallMethod; args: Record<string, unknown>}> = [];
    const redials: string[] = [];
    const vm = {
        reachable,
        landed: [landedPr(1, 10, 'switchboard', WAITING)] as LandedPullRequest[],
        answer: {} as Record<string, unknown>,
    };
    const link: MergingLink = {
        get connected() {
            return vm.reachable;
        },
        home: '/home/dev',
        whenConnected: () => (vm.reachable ? Promise.resolve() : Promise.reject(new Error('down'))),
        retryNow: () => void redials.push('retry'),
        runTool: async () => ({code: ghCode, stdout: Buffer.from(gh), stderr: ''}),
        mergeCall: async (method, args = {}) => {
            calls.push({method, args});
            if (!vm.reachable) throw new Error('the agent link dropped');
            if (method === 'state') {
                return {
                    state: mergeManagerState(vm.landed, new Map()),
                    landed: vm.landed,
                    errands: [],
                    savedByRepository: {},
                };
            }
            if (method === 'release') return {landed: vm.landed};
            return vm.answer[method] ?? {ok: true};
        },
    };
    let connected: ((key: string) => void) | null = null;
    let localFollower: ((t: LandedTransitions) => void) | null = null;
    const store = {record: record as MergingHostRecord};
    const pushed: MergeManagerState[] = [];
    const stopped: string[] = [];
    const transitions: LandedTransitions[] = [];
    const service = new MergingHostService({
        local: {
            state: () => mergeManagerState(landed, new Map()),
            land: async () => {
                told.push('local land');
                return {ok: false, reason: 'local'};
            },
            unland: async () => ({ok: true}),
            start: () => void told.push('local start'),
            pause: async () => void told.push('local pause'),
            focused: () => void told.push('local focused'),
            adopt: (prs) => {
                told.push(`local adopt ${prs.map((pr) => pr.number).join(',')}`);
                landed = [...prs];
            },
            all: () => landed,
            onTransitions: (fn) => void (localFollower = fn),
        },
        errands: {
            tryAgain: async () => ({ok: true, sessionId: 'local'}),
            handOver: () => ['errand-session'],
        },
        page: {
            facts: async () => ({
                savedThisWeek: {'update-not-pushed': 0, 'run-cancelled': 0, 'conflict-found': 0},
                savedByRepository: {},
                errands: [],
                checkouts: {'movelab/connect': '/code/connect'},
            }),
        },
        vms: () => [DEVBOX],
        link: (key) => (key === DEVBOX.key ? link : null),
        onConnected: (listener) => void (connected = listener),
        record: {read: () => store.record, write: (next) => void (store.record = next)},
        stopSession: (id) => void stopped.push(id),
        renderer: {mergeManagerChanged: (state) => void pushed.push(state)},
        clock: {now: () => NOW},
        timers: fakeTimers(),
        log: silentLog,
    });
    service.onTransitions((t) => void transitions.push(t));
    return {
        service,
        told,
        calls,
        redials,
        vm,
        store,
        pushed,
        stopped,
        transitions,
        connect: (key: string) => connected?.(key),
        localTransitions: (t: LandedTransitions) => localFollower?.(t),
    };
}

const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('a hand-off stops the local runner and errands and gives the VM the landed PRs', async () => {
    /* Given */
    const {service, told, calls, stopped, store} = setup();

    /* When */
    const answer = await service.handOff();

    /* Then */
    assert.deepEqual(answer, {ok: true, warning: null});
    assert.deepEqual(told, ['local pause']);
    assert.deepEqual(stopped, ['errand-session']);
    assert.equal(calls[0].method, 'take');
    assert.deepEqual(
        (calls[0].args.landed as LandedPullRequest[]).map((pr) => pr.number),
        [1],
    );
    assert.equal(store.record.kind, 'vm');
    assert.equal(service.state().merging?.kind, 'vm');
});

test('a hand-off to a VM with no GitHub login is refused with the fix, and the Mac keeps merging', async () => {
    /* Given */
    const {service, told, calls, store} = setup({gh: 'You are not logged into any GitHub hosts.', ghCode: 1});

    /* When */
    const answer = await service.handOff();

    /* Then */
    assert.deepEqual(answer, {
        ok: false,
        reason: 'devbox is not signed in to GitHub, so it could not update or merge anything.',
        fix: 'On devbox, run: gh auth login',
    });
    assert.deepEqual(told, []);
    assert.deepEqual(calls, []);
    assert.equal(store.record.kind, 'mac');
});

test('a hand-off warns when the VM login lacks the workflow scope, and tells the VM', async () => {
    /* Given */
    const {service, calls} = setup({gh: "✓ Logged in to github.com account joris\n  - Token scopes: 'repo'"});

    /* When */
    const answer = await service.handOff();

    /* Then */
    assert.equal(answer.ok, true);
    assert.match(String(answer.ok && answer.warning), /gh auth refresh -s workflow/);
    assert.equal(calls[0].args.noWorkflowScope, true);
});

test('while the VM merges, Land it is forwarded to it and not run here', async () => {
    /* Given */
    const {service, told, calls} = setup({record: handedOff(DEVBOX, null, NOW)});

    /* When */
    await service.land('movelab/connect', 9);

    /* Then */
    assert.deepEqual(told, []);
    assert.deepEqual(calls[0], {method: 'land', args: {repository: 'movelab/connect', number: 9}});
});

test('bring back adopts what the VM hands back and starts merging here', async () => {
    /* Given */
    const {service, told, vm, store} = setup({record: handedOff(DEVBOX, null, NOW)});
    vm.landed = [landedPr(1, 10, 'switchboard', {kind: 'merged', at: NOW}), landedPr(2, 5, 'switchboard', WAITING)];

    /* When */
    const answer = await service.bringBack();

    /* Then */
    assert.deepEqual(answer, {ok: true});
    assert.deepEqual(told, ['local adopt 1,2', 'local start']);
    assert.equal(store.record.kind, 'mac');
});

test('bring back with the VM down offers take back anyway, which works without it', async () => {
    /* Given */
    const {service, told, vm, store} = setup({record: handedOff(DEVBOX, null, NOW), reachable: false});

    /* When */
    const answer = await service.bringBack();
    const taken = service.takeBackAnyway();

    /* Then */
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.unreachable, true);
    assert.deepEqual(taken, {ok: true});
    assert.deepEqual(told, ['local adopt 1', 'local start']);
    assert.deepEqual(store.record, {kind: 'mac', lastVm: DEVBOX.key, standDown: DEVBOX});
    void vm;
});

test('a VM merging was taken back from stands down when it reconnects', async () => {
    /* Given */
    const {service, calls, connect, vm, store} = setup({record: handedOff(DEVBOX, null, NOW), reachable: false});
    service.takeBackAnyway();
    vm.reachable = true;

    /* When */
    connect(DEVBOX.key);
    await settle();

    /* Then */
    assert.deepEqual(
        calls.map((call) => call.method),
        ['stand-down'],
    );
    assert.deepEqual(store.record, {kind: 'mac', lastVm: DEVBOX.key, standDown: null});
});

test("merges and Needs you seen in the VM's reads are told like the Mac's own", async () => {
    /* Given */
    const {service, vm, transitions} = setup({record: handedOff(DEVBOX, null, NOW)});
    service.start();
    await settle();
    vm.landed = [landedPr(1, 10, 'switchboard', {kind: 'merged', at: NOW})];

    /* When */
    service.focused();
    await settle();

    /* Then */
    assert.deepEqual(
        transitions.map((t) => t.merged.map((pr) => pr.number)),
        [[1]],
    );
    service.stop();
});

test('focusing the window dials a VM link that gave up again', async () => {
    /* Given */
    const {service, redials} = setup({record: handedOff(DEVBOX, null, NOW), reachable: false});

    /* When */
    service.focused();
    await settle();

    /* Then */
    assert.deepEqual(redials, ['retry']);
});

test('Land it while merging is on a VM whose link gave up dials it again before forwarding', async () => {
    /* Given */
    const {service, redials, calls} = setup({record: handedOff(DEVBOX, null, NOW), reachable: false});

    /* When */
    await service.land('JBlaak/switchboard', 7).catch(() => null);

    /* Then */
    assert.deepEqual(redials, ['retry']);
    assert.deepEqual(
        calls.map((call) => call.method),
        ['land'],
    );
});

test("the minute's read of a VM does not dial a link that gave up", async () => {
    /* Given */
    const {service, redials} = setup({record: handedOff(DEVBOX, null, NOW), reachable: false});

    /* When */
    service.start();
    await settle();

    /* Then */
    assert.deepEqual(redials, []);
    service.stop();
});

test("the page shows the VM's errands and savings with the checkouts from here", async () => {
    /* Given */
    const {service} = setup({record: handedOff(DEVBOX, null, NOW)});
    service.start();
    await settle();

    /* When */
    const facts = await service.pageFacts();

    /* Then */
    assert.deepEqual(facts.checkouts, {'movelab/connect': '/code/connect'});
    assert.deepEqual(facts.errands, []);
    service.stop();
});
