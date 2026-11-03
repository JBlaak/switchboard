/**
 * VM projects in the sidebar (#276): the badge a remote project carries, the
 * buttons a session row on a VM offers, and the reason Session work isn't
 * there for it yet.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rowButtons} from '../src/renderer/state/session-list-layout';
import {remoteBadge} from '../src/renderer/features/sessions/remote-badge';
import {REMOTE_REASON, VM_REASON, workTrigger} from '../src/renderer/ui/session-list/work-trigger';
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
    assert.deepEqual(buttons, {stop: 'Stop session', archive: 'Archive', snooze: true, resume: true, handOff: false});
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
    });
});

test('a local Claude session is unchanged', () => {
    /* When */
    const buttons = rowButtons(session(), {vm: false});

    /* Then */
    assert.deepEqual(buttons, {stop: 'Stop session', archive: 'Archive', snooze: true, resume: true, handOff: false});
});

// ── Session work ──

test('Session work on a VM row says it is not there on a VM yet', () => {
    /* When */
    const trigger = workTrigger(true, undefined, {vm: true});

    /* Then */
    assert.deepEqual(trigger, {button: false, reason: VM_REASON});
});

test('Session work on an agentless remote row keeps its reason', () => {
    /* When */
    const trigger = workTrigger(true, undefined);

    /* Then */
    assert.deepEqual(trigger, {button: false, reason: REMOTE_REASON});
});
