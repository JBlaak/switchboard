/** The VM's lane state file (#438, #442): read defensively, written whole, and what a restart leaves behind. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    EMPTY_LANE_STATE,
    SAVINGS_KEPT_MS,
    deadErrands,
    parseLaneState,
    serializeLaneState,
    type LaneState,
} from '../src/domain/agent/lane-state';
import {LaneStateStore} from '../src/application/services/agent-host/lane-store';
import {NodeRecordFile} from '../src/infrastructure/agent/node-record-file';
import type {FixErrand} from '../src/domain/merge-manager/errands';
import {silentLog} from './support/fakes';
import {NOW, landedPr} from './support/merge-manager-fixtures';

function errand(id: string, overrides: Partial<FixErrand> = {}): FixErrand {
    return {
        id,
        key: 'movelab/connect#7',
        repository: 'movelab/connect',
        number: 7,
        branch: 'branch-7',
        lane: 'switchboard',
        cause: 'checks',
        headOid: 'oid-7',
        sessionId: `session-${id}`,
        currentId: `session-${id}`,
        worktree: '/home/dev/projects/connect/.claude/worktrees/errand-7',
        startedAt: NOW,
        finished: null,
        stoppedAt: null,
        ...overrides,
    };
}

const STATE: LaneState = {
    landed: [landedPr(7, 10, 'switchboard', {kind: 'fixing', cause: 'checks'})],
    errands: [errand('a')],
    savings: [{repository: 'movelab/connect', kind: 'run-cancelled', count: 2, at: NOW}],
    noWorkflowScope: true,
};

test('the lane state reads back as it was written', () => {
    /* When */
    const read = parseLaneState(serializeLaneState(STATE));

    /* Then */
    assert.deepEqual(read, STATE);
});

test('a missing, malformed or older lane state file reads as empty', () => {
    /* Then */
    assert.deepEqual(parseLaneState(null), EMPTY_LANE_STATE);
    assert.deepEqual(parseLaneState('{not json'), EMPTY_LANE_STATE);
    assert.deepEqual(parseLaneState(JSON.stringify({landed: [], errands: []})), EMPTY_LANE_STATE);
});

test('a malformed entry is skipped and the rest is kept', () => {
    /* Given */
    const text = JSON.stringify({
        version: 2,
        landed: [{key: 'x'}, STATE.landed[0]],
        errands: [{id: 'b'}, STATE.errands[0]],
        savings: [{repository: 'movelab/connect', kind: 'nonsense', count: 1, at: NOW}],
    });

    /* When */
    const read = parseLaneState(text);

    /* Then */
    assert.deepEqual(read, {...STATE, savings: [], noWorkflowScope: false});
});

test('after a restart the running errands whose session is gone are the dead ones', () => {
    /* Given */
    const state: LaneState = {
        ...STATE,
        errands: [
            errand('gone'),
            errand('alive'),
            errand('stopped', {stoppedAt: NOW}),
            errand('done', {finished: {outcome: 'pushed', note: '', at: NOW}}),
        ],
    };

    /* When */
    const dead = deadErrands(state, (sessionId) => sessionId === 'session-alive');

    /* Then */
    assert.deepEqual(
        dead.map((e) => e.id),
        ['gone'],
    );
});

test('the store keeps landed PRs, errands and savings in one file, 0600, that a new store reads back', () => {
    /* Given */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-state-'));
    const file = new NodeRecordFile(path.join(dir, 'lane-state.json'));
    const store = new LaneStateStore({file, clock: {now: () => NOW}, log: silentLog});

    /* When */
    store.apply([landedPr(7, 10), landedPr(8, 5)], []);
    store.apply([], ['movelab/connect#8']);
    store.errandStore.save(errand('a'));
    store.add('movelab/connect', 'conflict-found', 1, NOW);
    store.add('movelab/connect', 'conflict-found', 1, NOW - SAVINGS_KEPT_MS - 1);
    const again = new LaneStateStore({file, clock: {now: () => NOW}, log: silentLog});

    /* Then */
    assert.deepEqual(
        again.all().map((pr) => pr.number),
        [7],
    );
    assert.deepEqual(
        again.errandStore.all().map((e) => e.id),
        ['a'],
    );
    assert.deepEqual(again.since(NOW - 1000), {'update-not-pushed': 0, 'run-cancelled': 0, 'conflict-found': 1});
    assert.equal(fs.statSync(path.join(dir, 'lane-state.json')).mode & 0o777, 0o600);
    fs.rmSync(dir, {recursive: true, force: true});
});
