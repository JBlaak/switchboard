/** The Merging host (#442): one owner, the GitHub check, routing, the quit prompt and the away summary. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    MAC_HOST,
    actionRoute,
    awayBubble,
    awayRef,
    awaySummary,
    broughtBack,
    dismissedSummary,
    ghAuthCheck,
    handedOff,
    linkTrouble,
    mergingHostView,
    onVmConnected,
    parseMergingHostRecord,
    pickVm,
    quitPrompt,
    stoodDown,
    tookBackAnyway,
} from '../src/domain/merge-manager/merging-host';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import type {LaneStage} from '../src/domain/merge-manager/model';
import {MIN, NOW, landedPr} from './support/merge-manager-fixtures';

const DEVBOX = {key: 'dev@devbox:22', name: 'devbox'};
const SPARE = {key: 'dev@spare:22', name: 'spare'};
const WAITING: LaneStage = {kind: 'waiting', willConflict: false, position: null};

const LOGGED_IN = `github.com
  ✓ Logged in to github.com account joris (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`;

// ── The GitHub check ──

test('a VM signed in with the workflow scope hands off without a warning', () => {
    /* When */
    const check = ghAuthCheck({code: 0, output: LOGGED_IN}, 'devbox');

    /* Then */
    assert.deepEqual(check, {ok: true, warning: null});
});

test('a VM with no GitHub login refuses the hand-off, with the fix', () => {
    /* When */
    const check = ghAuthCheck(
        {code: 1, output: 'You are not logged into any GitHub hosts. To log in, run: gh auth login'},
        'devbox',
    );

    /* Then */
    assert.equal(check.ok, false);
    assert.equal(check.ok === false && check.fix, 'On devbox, run: gh auth login');
});

test('a VM whose login lacks the workflow scope hands off with a warning and the refresh command', () => {
    /* When */
    const check = ghAuthCheck({code: 0, output: LOGGED_IN.replace(", 'workflow'", '')}, 'devbox');

    /* Then */
    assert.equal(check.ok, true);
    assert.match(String(check.ok && check.warning), /gh auth refresh -s workflow/);
});

// ── One owner ──

test('a hand-off makes the VM the one owner, and Land it, Unland and Try again go to it', () => {
    /* When */
    const record = handedOff(DEVBOX, null, NOW);

    /* Then */
    assert.deepEqual(actionRoute(record), {to: 'vm', vm: DEVBOX});
    assert.deepEqual(actionRoute(MAC_HOST), {to: 'mac'});
});

test('bringing merging back makes the Mac the owner, with nothing for the VM to hear', () => {
    /* When */
    const record = broughtBack(handedOff(DEVBOX, null, NOW));

    /* Then */
    assert.deepEqual(record, {kind: 'mac', lastVm: DEVBOX.key, standDown: null});
    assert.equal(onVmConnected(record, DEVBOX.key), null);
});

test('take back anyway makes the Mac the owner at once, and the VM stands down when it reconnects', () => {
    /* Given */
    const record = tookBackAnyway(handedOff(DEVBOX, null, NOW));

    /* When */
    const onDevbox = onVmConnected(record, DEVBOX.key);
    const onSpare = onVmConnected(record, SPARE.key);

    /* Then */
    assert.equal(record.kind, 'mac');
    assert.equal(onDevbox, 'stand-down');
    assert.equal(onSpare, null);
    assert.equal(onVmConnected(stoodDown(record), DEVBOX.key), null);
});

test('a stored record survives a restart, and anything malformed is the Mac', () => {
    /* Given */
    const record = handedOff(DEVBOX, 'no workflow scope', NOW);

    /* Then */
    assert.deepEqual(parseMergingHostRecord(JSON.parse(JSON.stringify(record))), record);
    assert.deepEqual(parseMergingHostRecord({kind: 'vm'}), MAC_HOST);
    assert.deepEqual(parseMergingHostRecord('nonsense'), MAC_HOST);
});

test('with several VMs the last choice is offered first', () => {
    /* Then */
    assert.deepEqual(pickVm([DEVBOX, SPARE], SPARE.key), SPARE);
    assert.deepEqual(pickVm([DEVBOX, SPARE], 'gone@box:22'), DEVBOX);
    assert.equal(pickVm([], null), null);
});

// ── On quit ──

test('quitting with a landed PR in a Switchboard lane asks to hand off to the VM offered first', () => {
    /* Given */
    const state = mergeManagerState([landedPr(1, 5, 'switchboard', WAITING)], new Map());

    /* When */
    const prompt = quitPrompt({kind: 'mac', lastVm: SPARE.key, standDown: null}, state, [DEVBOX, SPARE]);

    /* Then */
    assert.deepEqual(prompt, {vm: SPARE, vms: [DEVBOX, SPARE]});
});

test('quitting asks nothing with no VM, with only queue lanes, with merged PRs only, or while a VM merges', () => {
    /* Given */
    const sb = mergeManagerState([landedPr(1, 5, 'switchboard', WAITING)], new Map());
    const queue = mergeManagerState([landedPr(1, 5, 'queue', WAITING)], new Map());
    const merged = mergeManagerState([landedPr(1, 5, 'switchboard', {kind: 'merged', at: NOW})], new Map());

    /* Then */
    assert.equal(quitPrompt(MAC_HOST, sb, []), null);
    assert.equal(quitPrompt(MAC_HOST, queue, [DEVBOX]), null);
    assert.equal(quitPrompt(MAC_HOST, merged, [DEVBOX]), null);
    assert.equal(quitPrompt(handedOff(DEVBOX, null, NOW), sb, [DEVBOX]), null);
});

// ── While merging was on the VM ──

function awayState() {
    return mergeManagerState(
        [
            landedPr(1, 50, 'switchboard', {kind: 'merged', at: NOW + 10 * MIN}),
            landedPr(2, 40, 'switchboard', {kind: 'merged', at: NOW + 20 * MIN}),
            landedPr(3, 30, 'switchboard', {kind: 'merged', at: NOW - 60 * MIN}),
            landedPr(4, 20, 'switchboard', {kind: 'needsYou', reason: {kind: 'errand-stopped', question: 'Which?'}}),
            landedPr(5, 10, 'switchboard', {kind: 'fixing', cause: 'conflict'}),
            landedPr(6, 5, 'switchboard', WAITING),
        ],
        new Map(),
    );
}

test('the away summary lists what merged since the hand-off, what needs me with its question, and errands running', () => {
    /* When */
    const summary = awaySummary(handedOff(DEVBOX, null, NOW), awayState());

    /* Then */
    assert.deepEqual(
        summary && {
            vm: summary.vm,
            merged: summary.merged.map((pr) => pr.number),
            needsYou: summary.needsYou.map((pr) => [pr.number, pr.question]),
            running: summary.running.map((pr) => pr.number),
        },
        {vm: 'devbox', merged: [2, 1], needsYou: [[4, 'Which?']], running: [5]},
    );
    assert.equal(awayBubble(summary), '2 merged · 1 needs you');
});

test('the away summary goes once dismissed or once merging is back', () => {
    /* Given */
    const record = handedOff(DEVBOX, null, NOW);

    /* Then */
    assert.equal(awaySummary(dismissedSummary(record), awayState()), null);
    assert.equal(awaySummary(broughtBack(record), awayState()), null);
    assert.equal(awayBubble(null), null);
});

test('the view names the VM, and says when it has not answered', () => {
    /* When */
    const view = mergingHostView(handedOff(DEVBOX, null, NOW), awayState(), [DEVBOX], {
        reachable: false,
        reconnecting: false,
        reason: 'ssh: connect to host 10.0.0.2 port 22: Operation timed out',
    });

    /* Then */
    assert.equal(view.kind, 'vm');
    assert.equal(view.kind === 'vm' && view.reachable, false);
    assert.equal(
        view.kind === 'vm' && view.trouble,
        'devbox cannot be reached over the network. Check the network or VPN.',
    );
    assert.deepEqual(
        mergingHostView(MAC_HOST, awayState(), [DEVBOX], {reachable: true, reconnecting: false, reason: null}),
        {
            kind: 'mac',
            vms: [DEVBOX],
            offered: DEVBOX,
        },
    );
});

test('an away PR says which repository it came from, without the owner', () => {
    /* Given */
    const pr = {key: 'k', repository: 'JBlaak/switchboard', number: 461, title: 'Shelf', url: 'u'};

    /* When */
    const ref = awayRef(pr);

    /* Then */
    assert.equal(ref, 'switchboard #461');
});

test('a link failure is said in words, with what fixes it', () => {
    /* Given */
    const said = {
        signing:
            'sign_and_send_pubkey: signing failed for ED25519 "/Users/joris/.ssh/vm.pub" from agent: communication with agent failed dev@devbox: Permission denied (publickey).',
        refused: 'dev@devbox: Permission denied (publickey).',
        network: 'ssh: connect to host 10.0.0.2 port 22: Operation timed out',
        name: 'ssh: Could not resolve hostname devbox.local: nodename nor servname provided',
        quiet: 'no answer in 20s',
        odd: 'something else entirely',
    };

    /* When */
    const words = Object.fromEntries(Object.entries(said).map(([k, reason]) => [k, linkTrouble('devbox', reason)]));

    /* Then */
    assert.deepEqual(words, {
        signing: '1Password did not sign in to devbox with your ssh key. Approve it in 1Password, then reconnect.',
        refused: 'devbox refused your ssh key.',
        network: 'devbox cannot be reached over the network. Check the network or VPN.',
        name: "devbox's address was not found. Check the network or VPN.",
        quiet: 'devbox did not answer in time.',
        odd: 'devbox did not answer: something else entirely',
    });
    assert.equal(linkTrouble('devbox', null), 'devbox has not answered lately.');
});
