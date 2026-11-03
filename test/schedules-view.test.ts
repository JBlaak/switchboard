/**
 * Where a project's schedules run, as the pages and the hand-off dialog say
 * it (#276 stage 5, Q18): the Schedules line on a local project's page and on
 * a copy's, hidden with no schedules, and the dialog's checkbox and what it
 * passes along.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    handoffChoices,
    ON_MAC,
    runOnTarget,
    SCHEDULES_CHOICE,
    schedulesChoice,
    schedulesSwitch,
} from '../src/renderer/ui/project-page/schedules-view';
import type {HandoffHost, ProjectCopy} from '../src/application/services/project-handoff';
import type {ScheduleLocation} from '../src/application/services/vm-schedules';

const LOCAL = '/Users/me/code/app';
const COPY = 'ssh://dev@buildbox/home/dev/projects/app';
const OTHER_COPY = 'ssh://me@gpu/srv/app';
const HOST: HandoffHost = {key: 'dev@buildbox:22', label: 'dev@buildbox'};
const COPIES: ProjectCopy[] = [{copyPath: COPY, hostKey: HOST.key, hostLabel: HOST.label}];

function location(runsOn: ScheduleLocation['runsOn'], count = 3): ScheduleLocation {
    return {localPath: LOCAL, runsOn, count};
}

// ── The Schedules line ──

test('a local page with a copy and schedules on the Mac offers to move them to the copy', () => {
    /* Given */
    const where = location({kind: 'mac'});

    /* When */
    const line = schedulesSwitch(LOCAL, where, COPIES);

    /* Then */
    assert.deepEqual(line, {
        localPath: LOCAL,
        count: '3 schedules',
        options: [
            {value: ON_MAC, label: 'Run on this Mac'},
            {value: COPY, label: 'Run on dev@buildbox (copy)'},
        ],
        selected: ON_MAC,
    });
});

test('a local page whose copy runs the schedules has that copy picked', () => {
    /* When */
    const line = schedulesSwitch(LOCAL, location({kind: 'vm', copyPath: COPY}, 1), COPIES);

    /* Then */
    assert.equal(line?.selected, COPY);
    assert.equal(line?.count, '1 schedule');
});

test('a local page with schedules but no copy shows no line', () => {
    /* When */
    const line = schedulesSwitch(LOCAL, location({kind: 'mac'}), []);

    /* Then */
    assert.equal(line, null);
});

test('a copy’s page offers Run here and Run on the Mac, for the local project', () => {
    /* When */
    const line = schedulesSwitch(COPY, location({kind: 'mac'}), []);

    /* Then */
    assert.deepEqual(line?.options, [
        {value: COPY, label: 'Run here'},
        {value: ON_MAC, label: 'Run on the Mac'},
    ]);
    assert.equal(line?.selected, ON_MAC);
    assert.equal(line?.localPath, LOCAL);
});

test('a copy’s page has Run here picked while it runs them', () => {
    /* When */
    const line = schedulesSwitch(COPY, location({kind: 'vm', copyPath: COPY}), []);

    /* Then */
    assert.equal(line?.selected, COPY);
});

test('a copy’s page, while another copy runs them, shows that one picked by its host', () => {
    /* When */
    const line = schedulesSwitch(COPY, location({kind: 'vm', copyPath: OTHER_COPY}), []);

    /* Then */
    assert.deepEqual(line?.options.at(-1), {value: OTHER_COPY, label: 'Run on me@gpu (copy)'});
    assert.equal(line?.selected, OTHER_COPY);
});

test('no schedules, or no answer, hides the line on either page', () => {
    /* When */
    const lines = [
        schedulesSwitch(LOCAL, location({kind: 'mac'}, 0), COPIES),
        schedulesSwitch(COPY, location({kind: 'vm', copyPath: COPY}, 0), []),
        schedulesSwitch(LOCAL, null, COPIES),
    ];

    /* Then */
    assert.deepEqual(lines, [null, null, null]);
});

test('picking the Mac tells runOn null, and a copy its path', () => {
    /* When */
    const targets = [runOnTarget(ON_MAC), runOnTarget(COPY)];

    /* Then */
    assert.deepEqual(targets, [null, COPY]);
});

// ── The hand-off dialog's checkbox ──

test('the dialog offers to run the schedules on the VM when the project has some on the Mac', () => {
    /* When */
    const choice = schedulesChoice(location({kind: 'mac'}, 2), HOST, {existing: {}}, []);

    /* Then */
    assert.deepEqual(choice, {label: SCHEDULES_CHOICE, note: '2 schedules. Ticked, they stop running on this Mac.'});
    assert.equal(SCHEDULES_CHOICE, 'Run this project’s schedules on the VM');
});

test('the dialog says so when this host’s copy already runs them', () => {
    /* When */
    const choice = schedulesChoice(location({kind: 'vm', copyPath: COPY}, 1), HOST, {existing: {[HOST.key]: COPY}}, []);

    /* Then */
    assert.equal(choice?.note, '1 schedule. They already run in the copy on dev@buildbox.');
});

test('the dialog says so when a copy on another host runs them', () => {
    /* Given */
    const copies: ProjectCopy[] = [{copyPath: OTHER_COPY, hostKey: 'me@gpu:22', hostLabel: 'me@gpu'}];

    /* When */
    const choice = schedulesChoice(location({kind: 'vm', copyPath: OTHER_COPY}), HOST, {existing: {}}, copies);

    /* Then */
    assert.equal(choice?.note, '3 schedules. They run in the copy on me@gpu now; ticked, they move to this one.');
});

test('a project with no schedules, or before main has said, has no checkbox', () => {
    /* When */
    const none = schedulesChoice(location({kind: 'mac'}, 0), HOST, null, []);
    const unknown = schedulesChoice(null, HOST, null, []);

    /* Then */
    assert.equal(none, null);
    assert.equal(unknown, null);
});

test('the hand-off carries the checkbox when it shows, and nothing about schedules when it does not', () => {
    /* Given */
    const choice = schedulesChoice(location({kind: 'mac'}), HOST, null, []);

    /* When */
    const ticked = handoffChoices(choice, true);
    const unticked = handoffChoices(choice, false);
    const hidden = handoffChoices(null, true);

    /* Then */
    assert.deepEqual(ticked, {schedulesOnVm: true});
    assert.deepEqual(unticked, {schedulesOnVm: false});
    assert.deepEqual(hidden, {});
});
