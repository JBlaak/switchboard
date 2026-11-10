/**
 * VM projects in the sidebar (#276): the badge a remote project carries, the
 * buttons a session row on a VM offers, and whether Session work is asked
 * for it (#276 stage 4).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rowButtons} from '../src/renderer/state/session-list-layout';
import {remoteBadge} from '../src/renderer/features/sessions/remote-badge';
import {REMOTE_REASON, VM_SHELL_REASON, workOffReason, workTrigger} from '../src/renderer/ui/session-list/work-trigger';
import type {SessionRow} from '../src/domain/session/session';

function session(extra: Partial<SessionRow> = {}): SessionRow {
    return {
        sessionId: 's1',
        summary: 'Session',
        firstPrompt: '',
        projectPath: '/repo',
        created: '2026-11-01T00:00:00.000Z',
        modified: '2026-11-01T00:00:00.000Z',
        messageCount: 1,
        name: null,
        starred: 0,
        archived: 0,
        ...extra,
    };
}

const VM_CLAUDE = session({projectPath: 'ssh://me@vm/app', type: 'remote', remoteKind: 'claude'});

// ── The badge ──

test('a remote with an agent is badged VM, naming its host', () => {
    /* When */
    const badge = remoteBadge({projectPath: 'ssh://me@vm/app', remote: true, agent: true});

    /* Then */
    assert.deepEqual(badge, {label: 'VM', title: 'Runs on a Switchboard agent on me@vm'});
});

test('the VM badge names a port that is not 22', () => {
    /* When */
    const badge = remoteBadge({projectPath: 'ssh://me@vm:2222/app', remote: true, agent: true});

    /* Then */
    assert.equal(badge?.title, 'Runs on a Switchboard agent on me@vm:2222');
});

test('a remote without an agent keeps its SSH badge', () => {
    /* When */
    const badge = remoteBadge({projectPath: 'ssh://me@box/app', remote: true});

    /* Then */
    assert.deepEqual(badge, {label: 'SSH'});
});

test('a local project has no badge', () => {
    /* When */
    const badge = remoteBadge({projectPath: '/repo'});

    /* Then */
    assert.equal(badge, null);
});

// ── The row's buttons ──

test('a Claude session on a VM stops and resumes like a local one', () => {
    /* When */
    const buttons = rowButtons(VM_CLAUDE, {vm: true});

    /* Then */
    assert.deepEqual(buttons, {
        stop: 'Stop session',
        archive: 'Archive',
        snooze: true,
        resume: true,
        handOff: false,
        bringBack: false,
    });
});

test('a shell on a VM stops, and has nothing to resume', () => {
    /* Given */
    const shell = session({projectPath: 'ssh://me@vm/app', type: 'remote', remoteKind: 'shell'});

    /* When */
    const buttons = rowButtons(shell, {vm: true});

    /* Then */
    assert.equal(buttons.stop, 'Stop session');
    assert.equal(buttons.resume, false);
});

test('a session on an agentless remote still only disconnects', () => {
    /* When */
    const buttons = rowButtons(session({projectPath: 'ssh://me@box/app', type: 'remote', remoteKind: 'claude'}));

    /* Then */
    assert.deepEqual(buttons, {
        stop: 'Disconnect (keeps running on the remote)',
        archive: 'Archive',
        snooze: true,
        resume: false,
        handOff: false,
        bringBack: false,
    });
});

test('a local Claude session is unchanged', () => {
    /* When */
    const buttons = rowButtons(session(), {vm: false});

    /* Then */
    assert.deepEqual(buttons, {
        stop: 'Stop session',
        archive: 'Archive',
        snooze: true,
        resume: true,
        handOff: false,
        bringBack: false,
    });
});

// ── Session work ──

test('Session work on a VM Claude row is asked of main, and opens when main says it can', () => {
    /* When */
    const off = workOffReason(VM_CLAUDE, VM_CLAUDE.projectPath, true);
    const trigger = workTrigger(off, true);

    /* Then */
    assert.equal(off, null);
    assert.deepEqual(trigger, {button: true});
});

test('Session work on a VM Claude row waits for main, then says why when main says no', () => {
    /* When */
    const asking = workTrigger(workOffReason(VM_CLAUDE, VM_CLAUDE.projectPath, true), undefined);
    const refused = workTrigger(workOffReason(VM_CLAUDE, VM_CLAUDE.projectPath, true), false);

    /* Then */
    assert.deepEqual(asking, {button: false, reason: undefined});
    assert.deepEqual(refused, {button: false, reason: 'Not a git repository'});
});

test('Session work on a shell on a VM stays off, and says so', () => {
    /* Given */
    const shell = session({projectPath: 'ssh://me@vm/app', type: 'remote', remoteKind: 'shell'});

    /* When */
    const off = workOffReason(shell, shell.projectPath, true);
    const trigger = workTrigger(off, true);

    /* Then */
    assert.equal(off, VM_SHELL_REASON);
    assert.deepEqual(trigger, {button: false, reason: VM_SHELL_REASON});
});

test('Session work on an agentless remote row keeps its reason', () => {
    /* Given */
    const remote = session({projectPath: 'ssh://me@box/app', type: 'remote', remoteKind: 'claude'});

    /* When */
    const off = workOffReason(remote, remote.projectPath, false);
    const trigger = workTrigger(off, true);

    /* Then */
    assert.equal(off, REMOTE_REASON);
    assert.deepEqual(trigger, {button: false, reason: REMOTE_REASON});
});

test('Session work on a local row is asked of main, as before', () => {
    /* When */
    const off = [workOffReason(session(), '/repo', false), workOffReason({type: 'terminal'}, '/repo', false)];

    /* Then */
    assert.deepEqual(off, [null, null]);
});
