/**
 * What Settings → VMs says (#307): a row's agent and connection lines, Add a
 * VM's messages, Remove's question, and a failed call.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    addressLine,
    addVmPort,
    addVmProblem,
    agentLine,
    connectionLine,
    removeVmPrompt,
    vmFailureLine,
} from '../src/renderer/ui/vms/vms-copy';
import {hostKeyOfPath, hostPathOfKey, vmAddress} from '../src/renderer/ui/vms/vm-hosts';
import type {VmHostView} from '../src/application/services/vm-registry';

function vmHost(fields: Partial<VmHostView> = {}): VmHostView {
    return {
        key: 'dev@devbox:22',
        user: 'dev',
        host: 'devbox',
        port: 22,
        label: 'dev@devbox',
        agent: '2.11.9',
        current: true,
        connected: true,
        projects: [],
        ...fields,
    };
}

const IDLE = {phase: 'idle'} as const;
const input = (fields: Partial<{user: string; host: string; port: string; name: string}> = {}) => ({
    user: 'dev',
    host: 'devbox',
    port: '',
    name: '',
    ...fields,
});

// ── A row's lines ──

test('a VM with the app’s agent names its version', () => {
    /* When */
    const line = agentLine(vmHost(), IDLE);

    /* Then */
    assert.deepEqual(line, {text: 'Agent 2.11.9', tone: 'ok'});
});

test('a VM whose agent isn’t the app’s version says an update is available', () => {
    /* When */
    const line = agentLine(vmHost({agent: '2.10.0', current: false}), IDLE);

    /* Then */
    assert.deepEqual(line, {text: 'Update available', tone: 'update'});
});

test('a VM with no agent says so', () => {
    /* When */
    const line = agentLine(vmHost({agent: null, current: false, connected: false}), IDLE);

    /* Then */
    assert.deepEqual(line, {text: 'No agent yet', tone: 'none'});
});

test('while an install runs the row says Installing…, and Updating… over an agent', () => {
    /* Given */
    const running = {phase: 'running', lines: []} as const;

    /* When */
    const install = agentLine(vmHost({agent: null, current: false}), running);
    const update = agentLine(vmHost({agent: '2.10.0', current: false}), running);

    /* Then */
    assert.deepEqual(install, {text: 'Installing…', tone: 'busy'});
    assert.deepEqual(update, {text: 'Updating…', tone: 'busy'});
});

test('a VM with an agent is connected or offline; one with none says neither', () => {
    /* When */
    const connected = connectionLine(vmHost());
    const offline = connectionLine(vmHost({connected: false}));
    const none = connectionLine(vmHost({agent: null, connected: false}));

    /* Then */
    assert.deepEqual(connected, {text: 'Connected', connected: true});
    assert.deepEqual(offline, {text: 'Offline', connected: false});
    assert.equal(none, null);
});

test('the address shows under a VM’s name, not again under a label that is the address', () => {
    /* When */
    const named = addressLine(vmHost({label: 'Dev VM', key: 'dev@devbox:2222', port: 2222}));
    const unnamed = addressLine(vmHost());

    /* Then */
    assert.equal(named, 'dev@devbox:2222');
    assert.equal(unnamed, null);
});

// ── Add a VM ──

test('Add a VM takes a user and host, the port 22 when left empty', () => {
    /* When */
    const problem = addVmProblem(input(), []);
    const port = addVmPort(input());

    /* Then */
    assert.equal(problem, null);
    assert.equal(port, 22);
});

test('Add a VM asks for a user, then a host', () => {
    /* When */
    const noUser = addVmProblem(input({user: '  '}), []);
    const noHost = addVmProblem(input({host: ''}), []);

    /* Then */
    assert.equal(noUser, 'Enter the user to sign in as.');
    assert.equal(noHost, 'Enter the VM’s host name or address.');
});

test('Add a VM refuses what ssh can’t be given', () => {
    /* When */
    const user = addVmProblem(input({user: 'me;rm'}), []);
    const host = addVmProblem(input({host: 'dev box'}), []);
    const port = addVmProblem(input({port: '70000'}), []);

    /* Then */
    assert.equal(user, 'Username may only contain letters, digits, ".", "_" and "-".');
    assert.equal(host, 'Host must be a hostname or IPv4 address.');
    assert.equal(port, 'Port must be a number between 1 and 65535.');
});

test('Add a VM refuses a VM that is registered already, by its name', () => {
    /* Given */
    const hosts = [vmHost({label: 'Dev VM'})];

    /* When */
    const same = addVmProblem(input({port: '22'}), hosts);
    const otherPort = addVmProblem(input({port: '2222'}), hosts);

    /* Then */
    assert.equal(same, 'Dev VM is registered already.');
    assert.equal(otherPort, null);
});

// ── Remove ──

test('Remove asks first, saying the projects leave and the agent and sessions keep running', () => {
    /* When */
    const prompt = removeVmPrompt(vmHost({label: 'Dev VM'}));

    /* Then */
    assert.equal(
        prompt,
        'Remove “Dev VM”?\n\nIts projects leave the list here. The agent and its sessions keep running on the VM, ' +
            'and adding it again brings them back.',
    );
});

// ── Failures ──

test('a failed call says what failed, and why when main said', () => {
    /* When */
    const why = vmFailureLine('rename', 'No such VM');
    const bare = vmFailureLine('remove', '');

    /* Then */
    assert.equal(why, "Couldn't rename the VM: No such VM");
    assert.equal(bare, "Couldn't remove the VM");
});

// ── Naming ──

test('a VM’s key, host path and address go back and forth', () => {
    /* When */
    const fromProject = hostKeyOfPath('ssh://dev@devbox:2222/home/dev/app');
    const fromHome = hostKeyOfPath('ssh://dev@devbox');
    const local = hostKeyOfPath('/Users/me/app');
    const path = hostPathOfKey('dev@devbox:22');
    const onPort = hostPathOfKey('dev@devbox:2222');
    const bad = hostPathOfKey('devbox');

    /* Then */
    assert.deepEqual([fromProject, fromHome, local], ['dev@devbox:2222', 'dev@devbox:22', null]);
    assert.deepEqual([path, onPort, bad], ['ssh://dev@devbox', 'ssh://dev@devbox:2222', null]);
    assert.equal(vmAddress({user: 'dev', host: 'devbox', port: 2222}), 'dev@devbox:2222');
});
