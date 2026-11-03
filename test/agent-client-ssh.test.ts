import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

import {AGENT_CONNECT_COMMAND} from '../src/domain/agent/layout';
import {encodeMessageFrame, FrameDecoder} from '../src/domain/agent/framing';
import {
    AGENT_STREAM_SENTINEL,
    buildAgentSshArgv,
    buildAgentSshSpawn,
    SentinelGate,
} from '../src/domain/agent/ssh-connect';
import {SshAgentDialer} from '../src/infrastructure/agent/ssh-agent-dialer';
import {silentLog} from './support/fakes';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {AgentMessage} from '../src/domain/agent/protocol';

/**
 * The ssh that carries the agent link: one per host, no PTY, the user's login
 * shell around it, and frames on its stdio.
 */

const HOST = {user: 'joris', host: 'vm.local', port: 22};

test('the link ssh asks for no PTY, no escapes and no agent forwarding, and runs the connect command', () => {
    /* When */
    const argv = buildAgentSshArgv(HOST);

    /* Then */
    assert.deepEqual(argv, [
        '-T',
        '-e',
        'none',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
        'joris@vm.local',
        AGENT_CONNECT_COMMAND,
    ]);
});

test('a host on another port gets -p', () => {
    /* When */
    const argv = buildAgentSshArgv({...HOST, port: 2222});

    /* Then */
    assert.deepEqual(argv.slice(-4), ['-p', '2222', 'joris@vm.local', AGENT_CONNECT_COMMAND]);
});

test('ssh runs inside the login shell, which prints the sentinel and then becomes ssh', () => {
    /* When */
    const spawn = buildAgentSshSpawn(HOST, '/bin/zsh');

    /* Then */
    assert.equal(spawn.file, '/bin/zsh');
    assert.deepEqual(spawn.args.slice(0, 3), ['-l', '-i', '-c']);
    assert.match(spawn.args[3], /^printf '%s\\n' '__SWITCHBOARD_AGENT_STREAM__'; exec ssh '-T' /);
    assert.ok(spawn.args[3].includes(`'${AGENT_CONNECT_COMMAND}'`), 'the $HOME stays quoted for the remote shell');
    assert.equal(spawn.sentinel, true);
});

test('without a shell ssh is spawned directly and there is no sentinel to skip', () => {
    /* When */
    const spawn = buildAgentSshSpawn(HOST, null);

    /* Then */
    assert.equal(spawn.file, 'ssh');
    assert.deepEqual(spawn.args, buildAgentSshArgv(HOST));
    assert.equal(spawn.sentinel, false);
});

test('what the rc files print before the sentinel is dropped, even with the sentinel split across chunks', () => {
    /* Given */
    const gate = new SentinelGate(true);
    const cut = 10;

    /* When */
    const first = gate.push(Buffer.from('Welcome to zsh!\n' + AGENT_STREAM_SENTINEL.slice(0, cut)));
    const second = gate.push(Buffer.from(AGENT_STREAM_SENTINEL.slice(cut) + 'FRAME'));
    const third = gate.push(Buffer.from('MORE'));

    /* Then */
    assert.equal(first.length, 0);
    assert.equal(second.toString(), 'FRAME');
    assert.equal(third.toString(), 'MORE');
});

/** A child process with piped stdio, driven by the test. */
function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill(signal?: string): boolean;
        killed: string[];
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    child.kill = (signal) => {
        child.killed.push(signal ?? 'SIGTERM');
        return true;
    };
    return child;
}

function dialer() {
    const child = fakeChild();
    const spawns: {file: string; args: readonly string[]}[] = [];
    const ssh = new SshAgentDialer({
        shell: () => '/bin/zsh',
        env: {PATH: '/usr/bin'},
        cwd: '/Users/joris',
        log: silentLog,
        spawn: (file, args) => {
            spawns.push({file, args});
            setImmediate(() => child.emit('spawn'));
            return child as unknown as ChildProcessWithoutNullStreams;
        },
    });
    return {ssh, child, spawns};
}

test('the dialed link reads frames after the sentinel and writes frames to stdin', async () => {
    /* Given */
    const {ssh, child, spawns} = dialer();
    const link = await ssh.dial(HOST);
    const received: AgentMessage[] = [];
    link.onMessage((m) => received.push(m));
    const written: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => written.push(chunk));
    const welcome: AgentMessage = {
        type: 'welcome',
        protocol: 1,
        agentVersion: '2.12.0',
        settings: {instructions: '', copyConfig: true, baseFolder: '~/projects'},
    };

    /* When */
    child.stdout.write(Buffer.concat([Buffer.from('motd\n' + AGENT_STREAM_SENTINEL), encodeMessageFrame(welcome)]));
    link.send({type: 'hello', protocol: 1, appVersion: '2.12.0'});
    await new Promise((resolve) => setImmediate(resolve));

    /* Then */
    assert.equal(spawns[0].file, '/bin/zsh');
    assert.deepEqual(received, [welcome]);
    const frames = new FrameDecoder().push(Buffer.concat(written));
    assert.deepEqual(frames, [{kind: 'message', message: {type: 'hello', protocol: 1, appVersion: '2.12.0'}}]);
});

test("a link that dies closes with ssh's own last words", async () => {
    /* Given */
    const {ssh, child} = dialer();
    const link = await ssh.dial(HOST);
    const reasons: string[] = [];
    link.onClose((reason) => reasons.push(reason));

    /* When */
    child.stderr.write('joris@vm.local: Permission denied (publickey).\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 255, null);

    /* Then */
    assert.deepEqual(reasons, ['joris@vm.local: Permission denied (publickey).']);
    assert.equal(link.closed, true);
});

test('ssh that cannot be started rejects the dial', async () => {
    /* Given */
    const child = fakeChild();
    const ssh = new SshAgentDialer({
        shell: () => null,
        env: {},
        cwd: '/',
        log: silentLog,
        spawn: () => {
            setImmediate(() => child.emit('error', new Error('spawn ssh ENOENT')));
            return child as unknown as ChildProcessWithoutNullStreams;
        },
    });

    /* When */
    const dialed = ssh.dial(HOST);

    /* Then */
    await assert.rejects(dialed, /ENOENT/);
});
