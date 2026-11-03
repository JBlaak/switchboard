/**
 * A VM's controls in Settings → VMs (#276, #307): Install agent or Update
 * agent with its progress, and the setup checks.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installView, offersUpdate, setupDone, toolLine, toolLines} from '../src/renderer/ui/vms/agent-host-view';

// ── Install agent ──

test('before an install the button says Install agent', () => {
    /* When */
    const view = installView({phase: 'idle'});

    /* Then */
    assert.deepEqual(view, {label: 'Install agent', disabled: false, lines: [], error: null});
});

test('while it installs the button waits and the lines show', () => {
    /* When */
    const view = installView({phase: 'running', lines: ['Checking systemd']});

    /* Then */
    assert.deepEqual(view, {label: 'Installing…', disabled: true, lines: ['Checking systemd'], error: null});
});

test('a failed install shows why, and the button says Retry', () => {
    /* When */
    const view = installView({phase: 'failed', lines: ['Checking systemd'], error: 'No systemd.'});

    /* Then */
    assert.deepEqual(view, {label: 'Retry', disabled: false, lines: ['Checking systemd'], error: 'No systemd.'});
});

test('an update in progress says Updating…', () => {
    /* When */
    const view = installView({phase: 'running', lines: []}, 'Update agent');

    /* Then */
    assert.equal(view.label, 'Updating…');
});

test('Update agent is offered only while the agent is not the app’s version', () => {
    /* When */
    const old = offersUpdate({agent: '2.11.0', current: false});
    const current = offersUpdate({agent: '2.12.0', current: true});
    const none = offersUpdate({agent: null, current: false});

    /* Then */
    assert.deepEqual([old, current, none], [true, false, false]);
});

// ── Setup checks ──

test('a signed-in tool is ready, with its version', () => {
    /* When */
    const line = toolLine({tool: 'gh', installed: true, version: '2.60.1', loggedIn: true});

    /* Then */
    assert.deepEqual(line, {tool: 'gh', state: 'ready', text: 'Installed, 2.60.1 · signed in'});
});

test('an installed tool that is signed out says so', () => {
    /* When */
    const line = toolLine({tool: 'claude', installed: true, version: '2.1.220', loggedIn: false});

    /* Then */
    assert.deepEqual(line, {tool: 'claude', state: 'signed-out', text: 'Installed, 2.1.220 · not signed in'});
});

test('git has no login, so it is ready once installed', () => {
    /* When */
    const line = toolLine({tool: 'git', installed: true, version: '2.43.0'});

    /* Then */
    assert.deepEqual(line, {tool: 'git', state: 'ready', text: 'Installed, 2.43.0'});
});

test('the checks list every tool in setup’s order, a missing answer as not installed', () => {
    /* When */
    const lines = toolLines([{tool: 'git', installed: true}]);

    /* Then */
    assert.deepEqual(lines, [
        {tool: 'claude', state: 'missing', text: 'Not installed'},
        {tool: 'gh', state: 'missing', text: 'Not installed'},
        {tool: 'git', state: 'ready', text: 'Installed'},
    ]);
});

test('setup is done only when every tool is ready', () => {
    /* Given */
    const ready = [
        {tool: 'claude' as const, installed: true, loggedIn: true},
        {tool: 'gh' as const, installed: true, loggedIn: true},
        {tool: 'git' as const, installed: true},
    ];

    /* When */
    const done = setupDone(ready);
    const signedOut = setupDone([...ready.slice(0, 1), {tool: 'gh', installed: true, loggedIn: false}, ready[2]]);

    /* Then */
    assert.equal(done, true);
    assert.equal(signedOut, false);
});
