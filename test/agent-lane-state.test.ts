import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    EMPTY_LANE_STATE,
    landPr,
    laneOrder,
    parseLaneState,
    recoveryPlan,
    serializeLaneState,
    unlandPr,
    withErrand,
    withoutErrandSession,
    type LaneErrand,
    type LaneState,
} from '../src/domain/agent/lane-state';
import {NodeRecordFile} from '../src/infrastructure/agent/node-record-file';

/**
 * The lane state a VM keeps while it is the Merging host (#438): what survives
 * an agent restart, how a damaged file reads, and what recovery does with
 * each errand.
 */

const landed = (number: number, landedAt: number, repo = 'JBlaak/switchboard') => ({
    repo,
    number,
    branch: `branch-${number}`,
    landedAt,
});

const errand = (number: number, sessionId: string, repo = 'JBlaak/switchboard'): LaneErrand => ({
    repo,
    number,
    branch: `branch-${number}`,
    sessionId,
    dir: `/home/dev/projects/switchboard/.claude/worktrees/errand-${number}`,
    prompt: `Fix #${number}`,
    startedAt: 10,
});

test('the state round-trips through its file text', () => {
    /* Given */
    const state: LaneState = {landed: [landed(432, 1), landed(433, 2)], errands: [errand(432, 's1')]};

    /* When */
    const read = parseLaneState(serializeLaneState(state));

    /* Then */
    assert.deepEqual(read, state);
});

test('the state round-trips through the real file, written 0600', (t) => {
    /* Given */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lane-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const file = path.join(dir, 'lane-state.json');
    const state: LaneState = {landed: [landed(432, 1)], errands: [errand(432, 's1')]};

    /* When */
    new NodeRecordFile(file).write(serializeLaneState(state));
    const read = parseLaneState(new NodeRecordFile(file).read());

    /* Then */
    assert.deepEqual(read, state);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a missing, garbled or wrongly shaped file reads as empty', () => {
    /* When */
    const states = [null, '{not json', '[]', '"x"', '{"landed": 3}'].map(parseLaneState);

    /* Then */
    for (const state of states) assert.deepEqual(state, EMPTY_LANE_STATE);
});

test('malformed entries and repeats of a pull request are skipped, the first one kept', () => {
    /* Given */
    const text = JSON.stringify({
        landed: [landed(1, 5), {repo: 'not a repo', number: 2, branch: 'b', landedAt: 1}, landed(1, 9), {number: 3}],
        errands: [errand(1, 's1'), {...errand(4, 's4'), prompt: ''}, {...errand(1, 's9'), repo: 'jblaak/SWITCHBOARD'}],
    });

    /* When */
    const state = parseLaneState(text);

    /* Then */
    assert.deepEqual(state, {landed: [landed(1, 5)], errands: [errand(1, 's1')]});
});

test('landing again keeps the first landed time, so the pull request keeps its place', () => {
    /* Given */
    const state = landPr(landPr(EMPTY_LANE_STATE, landed(1, 100)), landed(2, 200));

    /* When */
    const next = landPr(state, landed(1, 300));

    /* Then */
    assert.equal(next, state);
});

test('a lane is in land order and holds only its own repository', () => {
    /* Given */
    const state: LaneState = {
        landed: [landed(3, 300), landed(1, 100), landed(9, 50, 'JBlaak/patch'), landed(2, 200)],
        errands: [],
    };

    /* When */
    const lane = laneOrder(state, 'jblaak/switchboard');

    /* Then */
    assert.deepEqual(
        lane.map((pr) => pr.number),
        [1, 2, 3],
    );
});

test('unlanding takes the pull request out and drops its errand ownership', () => {
    /* Given */
    const state: LaneState = {landed: [landed(1, 1), landed(2, 2)], errands: [errand(1, 's1'), errand(2, 's2')]};

    /* When */
    const next = unlandPr(state, {repo: 'JBlaak/switchboard', number: 1});

    /* Then */
    assert.deepEqual(next, {landed: [landed(2, 2)], errands: [errand(2, 's2')]});
});

test("a pull request's new errand replaces its earlier one, and a session's end forgets it", () => {
    /* Given */
    const state = withErrand({landed: [landed(1, 1)], errands: []}, errand(1, 's1'));

    /* When */
    const replaced = withErrand(state, errand(1, 's2'));
    const ended = withoutErrandSession(replaced, 's2');

    /* Then */
    assert.deepEqual(replaced.errands, [errand(1, 's2')]);
    assert.deepEqual(ended.errands, []);
});

test('after a restart, errands of landed pull requests start again and the others are dropped', () => {
    /* Given */
    const state: LaneState = {
        landed: [landed(1, 1), landed(2, 2), landed(3, 3)],
        errands: [errand(1, 'gone'), errand(2, 'running'), errand(4, 'unlanded')],
    };

    /* When */
    const plan = recoveryPlan(state, (sessionId) => sessionId === 'running');

    /* Then */
    assert.deepEqual(plan, {
        running: [errand(2, 'running')],
        restart: [errand(1, 'gone')],
        drop: [errand(4, 'unlanded')],
    });
});
