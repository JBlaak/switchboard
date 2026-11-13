import {test} from 'node:test';
import assert from 'node:assert/strict';

import {HookForwarder} from '../src/application/services/agent-host/hook-forwarder';
import {
    MERGE_TICK_MS,
    MergeHost,
    recoveredPrompt,
    type LaneRunner,
} from '../src/application/services/agent-host/merge-host';
import {SessionHost} from '../src/application/services/agent-host/session-host';
import type {Copies, CopyRepo} from '../src/application/services/agent-host/copies';
import {parseLaneState, serializeLaneState, type LaneErrand} from '../src/domain/agent/lane-state';
import type {HostSettings} from '../src/domain/agent/protocol';
import {fakeTerminals, fakeTimers, resizingPty, silentLog, type FakePty} from './support/fakes';

/**
 * The Merge manager on the agent (#438), wired as `src/agent/parts.ts` wires
 * it: a real session host and hook forwarder over fake PTYs, a fake copies
 * part, and the lane state in memory. Nothing here has a Mac connected.
 */

const HOME = '/home/dev';
const REPO = 'JBlaak/switchboard';

/** A text file in memory, shared by hosts made over it (an agent restart). */
function memoryFile(text: string | null = null) {
    const file = {
        text,
        read: () => file.text,
        write: (next: string) => void (file.text = next),
    };
    return file;
}

type MemoryFile = ReturnType<typeof memoryFile>;

function harness({
    lane = memoryFile(),
    merging = true,
    runner,
    copiesFail,
}: {lane?: MemoryFile; merging?: boolean; runner?: LaneRunner; copiesFail?: string} = {}) {
    const terminals = fakeTerminals();
    const ptys: FakePty[] = [];
    let pid = 1;
    const spawn = terminals.spawn.bind(terminals);
    terminals.spawn = (spec) => {
        const pty = resizingPty(pid++);
        ptys.push(pty);
        terminals.nextPty = pty;
        return spawn(spec);
    };
    const timers = fakeTimers();
    let nextId = 0;
    const ids = {newId: () => `session-${++nextId}-0000`};
    const settings: HostSettings = {instructions: '', copyConfig: true, baseFolder: '~/projects', mergingHost: merging};

    let sessions: SessionHost | null = null;
    const hooks = new HookForwarder({
        endpoint: {url: 'http://127.0.0.1:4100', token: 'tok'},
        timers,
        ids,
        log: silentLog,
        stop: (launchId) => void sessions?.stop(launchId),
        selfArchived: memoryFile(),
        clock: {now: () => 1},
    });
    sessions = new SessionHost({
        terminals,
        loginShell: '/bin/bash',
        hooks,
        hostSettings: () => settings,
        git: {worktreeRoot: async (cwd) => cwd},
        home: HOME,
        selfStarted: memoryFile(),
        clock: {now: () => 1},
        timers,
        log: silentLog,
    });

    const ensured: CopyRepo[] = [];
    const worktrees: [string, string, string][] = [];
    const copies: Pick<Copies, 'ensureCopy' | 'errandWorktree'> = {
        ensureCopy: async (repo) => {
            ensured.push(repo);
            if (copiesFail) return {ok: false, error: copiesFail};
            const dir = `~/projects/${repo.name}`;
            return {ok: true, dir, abs: `${HOME}/projects/${repo.name}`, reused: false};
        },
        errandWorktree: async (copyAbs, branch, name) => {
            worktrees.push([copyAbs, branch, name]);
            return {ok: true, abs: `${copyAbs}/.claude/worktrees/${name}`};
        },
    };

    const merge = new MergeHost({
        laneFile: lane,
        sessions,
        hooks,
        copies,
        hostSettings: () => settings,
        ids,
        clock: {now: () => 7_000},
        timers,
        log: silentLog,
        runner,
    });
    return {merge, sessions, hooks, terminals, ptys, timers, lane, ensured, worktrees, settings};
}

/** A runner that records what it heard. */
function recordingRunner() {
    const heard: string[] = [];
    const runner: LaneRunner = {
        tick: async () => void heard.push('tick'),
        errandTurnEnded: (errand) => void heard.push(`turn #${errand.number}`),
        errandEnded: (errand, exitCode) => void heard.push(`ended #${errand.number} (${exitCode})`),
    };
    return {heard, runner};
}

const errandRequest = {repo: REPO, number: 432, branch: 'fix-lanes', prompt: 'Fix the conflict on #432'};

async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

// ── Errands with no Mac ──

test('a fix errand starts as a session of its own in a detached worktree of a copy the agent makes', async () => {
    /* Given */
    const h = harness();
    h.merge.land({repo: REPO, number: 432, branch: 'fix-lanes', landedAt: 1});

    /* When */
    const started = await h.merge.startErrand(errandRequest);

    /* Then */
    const dir = `${HOME}/projects/switchboard/.claude/worktrees/errand-432-session-`;
    assert.equal(started.ok, true);
    assert.deepEqual(h.ensured, [{name: 'switchboard', origin: `https://github.com/${REPO}.git`, github: REPO}]);
    assert.deepEqual(h.worktrees, [[`${HOME}/projects/switchboard`, 'fix-lanes', 'errand-432-session-']]);
    assert.equal(h.terminals.spawns[0].cwd, dir);
    assert.match(h.terminals.spawns[0].args[3], /'--permission-mode' 'auto'.*'--' 'Fix the conflict on #432'$/);
    assert.equal(h.sessions.isAlive('session-1-0000'), true);
    assert.deepEqual(parseLaneState(h.lane.text).errands, [
        {...errandRequest, sessionId: 'session-1-0000', dir, startedAt: 7_000},
    ]);
});

test("with no Mac connected, the runner hears an errand's turn end and its end", async () => {
    /* Given */
    const {heard, runner} = recordingRunner();
    const h = harness({runner});
    h.merge.land({repo: REPO, number: 432, branch: 'fix-lanes', landedAt: 1});
    await h.merge.startErrand(errandRequest);

    /* When */
    h.hooks.archiveTool.turnEnded('session-1-0000');
    h.ptys[0].emitExit(0);

    /* Then */
    assert.deepEqual(heard, ['turn #432', 'ended #432 (0)']);
    assert.deepEqual(parseLaneState(h.lane.text).errands, []);
});

test('an errand that archives itself with no Mac is stopped on its turn end, and the runner hears it end', async () => {
    /* Given */
    const {heard, runner} = recordingRunner();
    const h = harness({runner});
    h.merge.land({repo: REPO, number: 432, branch: 'fix-lanes', landedAt: 1});
    await h.merge.startErrand(errandRequest);
    await h.hooks.archiveTool.request('session-1-0000');

    /* When */
    h.hooks.archiveTool.turnEnded('session-1-0000');
    h.ptys[0].emitExit(143);

    /* Then */
    assert.deepEqual(h.terminals.signals, [[1, 'SIGTERM']]);
    assert.deepEqual(heard, ['turn #432', 'ended #432 (143)']);
});

test("turn ends and ends of sessions that are not errands are not the runner's", async () => {
    /* Given */
    const {heard, runner} = recordingRunner();
    const h = harness({runner});
    await h.sessions.startSelf({sessionId: 'someone-else', dir: '~/x'});

    /* When */
    h.hooks.archiveTool.turnEnded('someone-else');
    h.ptys[0].emitExit(0);

    /* Then */
    assert.deepEqual(heard, []);
});

test('a second errand for a pull request whose errand runs is refused', async () => {
    /* Given */
    const h = harness();
    h.merge.land({repo: REPO, number: 432, branch: 'fix-lanes', landedAt: 1});
    await h.merge.startErrand(errandRequest);

    /* When */
    const again = await h.merge.startErrand(errandRequest);

    /* Then */
    assert.deepEqual(again, {ok: false, error: '#432 already has an errand (session session-1-0000)'});
    assert.equal(h.terminals.spawns.length, 1);
});

test('an errand whose copy cannot be made answers why, and starts and records nothing', async () => {
    /* Given */
    const h = harness({copiesFail: 'Cloning JBlaak/switchboard failed: no access'});

    /* When */
    const started = await h.merge.startErrand(errandRequest);

    /* Then */
    assert.deepEqual(started, {ok: false, error: 'Cloning JBlaak/switchboard failed: no access'});
    assert.equal(h.terminals.spawns.length, 0);
    assert.equal(h.lane.text, null);
});

// ── Ticks ──

test('while this VM is not the Merging host, nothing runs', async () => {
    /* Given */
    const {heard, runner} = recordingRunner();
    const h = harness({merging: false, runner});

    /* When */
    h.merge.start();
    await settle();
    h.timers.tick();
    await settle();

    /* Then */
    assert.deepEqual(heard, []);
});

test('as Merging host the runner is ticked at start and every minute', async () => {
    /* Given */
    const {heard, runner} = recordingRunner();
    const h = harness({runner});

    /* When */
    h.merge.start();
    await settle();
    h.timers.tick();
    await settle();

    /* Then */
    assert.equal(MERGE_TICK_MS, 60_000);
    assert.deepEqual(heard, ['tick', 'tick']);
});

// ── Recovery after a restart ──

function stateAfterCrash(): MemoryFile {
    const errand = (number: number, sessionId: string): LaneErrand => ({
        repo: REPO,
        number,
        branch: `branch-${number}`,
        sessionId,
        dir: `/old/errand-${number}`,
        prompt: `Fix #${number}`,
        startedAt: 1,
    });
    return memoryFile(
        serializeLaneState({
            landed: [{repo: REPO, number: 432, branch: 'branch-432', landedAt: 1}],
            errands: [errand(432, 'died-with-agent'), errand(500, 'unlanded-meanwhile')],
        }),
    );
}

test('after a restart, the lane state is read again and a landed pull request gets a fresh errand', async () => {
    /* Given */
    const h = harness({lane: stateAfterCrash()});

    /* When */
    await h.merge.tick();

    /* Then */
    const state = parseLaneState(h.lane.text);
    assert.deepEqual(state.landed, [{repo: REPO, number: 432, branch: 'branch-432', landedAt: 1}]);
    assert.equal(state.errands.length, 1);
    assert.equal(state.errands[0].number, 432);
    assert.equal(state.errands[0].sessionId, 'session-1-0000');
    assert.equal(h.sessions.isAlive('session-1-0000'), true);
    assert.deepEqual(h.worktrees, [[`${HOME}/projects/switchboard`, 'branch-432', 'errand-432-session-']]);
    assert.ok(h.terminals.spawns[0].args[3].includes('ended when the Switchboard agent restarted'));
});

test('recovery runs once, and the runner then ticks with the lanes as they were', async () => {
    /* Given */
    const {heard, runner} = recordingRunner();
    const h = harness({lane: stateAfterCrash(), runner});

    /* When */
    await h.merge.tick();
    await h.merge.tick();

    /* Then */
    assert.equal(h.terminals.spawns.length, 1);
    assert.deepEqual(heard, ['tick', 'tick']);
    assert.deepEqual(
        h.merge.lane(REPO).map((pr) => pr.number),
        [432],
    );
});

test('an errand that cannot start again is forgotten, and the lanes still run', async () => {
    /* Given */
    const {heard, runner} = recordingRunner();
    const h = harness({lane: stateAfterCrash(), runner, copiesFail: 'no network'});

    /* When */
    await h.merge.tick();

    /* Then */
    assert.deepEqual(parseLaneState(h.lane.text).errands, []);
    assert.deepEqual(heard, ['tick']);
});

test("an orderly shutdown keeps the errands it ends, for the next start's recovery", async () => {
    /* Given */
    const {heard, runner} = recordingRunner();
    const h = harness({runner});
    h.merge.land({repo: REPO, number: 432, branch: 'fix-lanes', landedAt: 1});
    await h.merge.startErrand(errandRequest);
    const stop = h.merge.start();
    await settle();

    /* When */
    stop();
    h.sessions.terminateAll();
    h.ptys[0].emitExit(143);

    /* Then */
    assert.equal(parseLaneState(h.lane.text).errands.length, 1);
    assert.deepEqual(heard, ['tick']);
});

test('the recovered prompt keeps the old one and says why it starts again', () => {
    /* When */
    const prompt = recoveredPrompt({
        repo: REPO,
        number: 432,
        branch: 'fix-lanes',
        sessionId: 's',
        dir: '/d',
        prompt: 'Fix it',
        startedAt: 1,
    });

    /* Then */
    assert.ok(prompt.startsWith('Fix it\n\n'));
    assert.match(prompt, /fresh worktree at origin\/fix-lanes/);
});
