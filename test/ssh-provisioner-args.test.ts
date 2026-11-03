import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    buildProvisionSshArgv,
    isSshConnectFailure,
    remoteDirname,
    remotePathWord,
    remoteShCommand,
    sshFailureMessage,
    writeStdinToFileScript,
} from '../src/domain/agent/ssh-provision';

const host = {user: 'joris', host: 'vm.local', port: 22};

/** Runs a remote command line the way sshd would: handed to the user's shell as one string. */
function runAsRemote(commandLine: string, home: string, stdin?: string): string {
    return execFileSync('/bin/sh', ['-c', commandLine], {
        env: {PATH: process.env.PATH, HOME: home},
        input: stdin,
    }).toString();
}

test('the provisioning argv has no TTY, never prompts and has a connect timeout', () => {
    /* When */
    const argv = buildProvisionSshArgv(host, 'true');

    /* Then */
    assert.equal(argv[0], '-T');
    assert.ok(argv.includes('BatchMode=yes'));
    assert.ok(argv.includes('StrictHostKeyChecking=accept-new'));
    assert.ok(argv.includes('ConnectTimeout=10'));
    assert.ok(!argv.includes('-A'), 'the installer needs no agent forwarding');
    assert.ok(!argv.includes('-p'));
    assert.equal(argv[argv.length - 2], 'joris@vm.local');
});

test('a non-default port is passed with -p', () => {
    /* When */
    const argv = buildProvisionSshArgv({...host, port: 2222}, 'true');

    /* Then */
    assert.equal(argv[argv.indexOf('-p') + 1], '2222');
});

test('the remote command runs the script with sh, byte for byte', () => {
    /* Given */
    const script = `printf '%s\\n' "it's" "a \\"quoted\\" \\$word"\necho "$((1 + 2))"`;
    const home = mkdtempSync(path.join(tmpdir(), 'sb-prov-'));

    /* When */
    const output = runAsRemote(remoteShCommand(script), home);

    /* Then */
    assert.equal(output, `it's\na "quoted" $word\n3\n`);
});

test('a home path keeps $HOME expandable and quotes the rest', () => {
    /* When */
    const words = [
        remotePathWord('$HOME/.switchboard/agent/2.0.0'),
        remotePathWord('~/my dir/x'),
        remotePathWord('/srv/a$b'),
    ];

    /* Then */
    assert.deepEqual(words, [`"$HOME"/'.switchboard/agent/2.0.0'`, `"$HOME"/'my dir/x'`, `'/srv/a$b'`]);
});

test('remoteDirname answers the folder of a path', () => {
    /* When */
    const dirs = [remoteDirname('$HOME/.switchboard/bin/x'), remoteDirname('/x'), remoteDirname('x')];

    /* Then */
    assert.deepEqual(dirs, ['$HOME/.switchboard/bin', '/', '.']);
});

test('the write script creates the folder, writes stdin and sets the mode', () => {
    /* Given */
    const home = mkdtempSync(path.join(tmpdir(), 'sb-prov-'));

    /* When */
    runAsRemote(remoteShCommand(writeStdinToFileScript('$HOME/.switchboard/bin/tool', 0o755)), home, 'hello\n');

    /* Then */
    const file = path.join(home, '.switchboard/bin/tool');
    assert.equal(readFileSync(file, 'utf8'), 'hello\n');
    assert.equal(statSync(file).mode & 0o777, 0o755);
});

test('the write script replaces an existing file', () => {
    /* Given */
    const home = mkdtempSync(path.join(tmpdir(), 'sb-prov-'));
    runAsRemote(remoteShCommand(writeStdinToFileScript('$HOME/f')), home, 'old');

    /* When */
    runAsRemote(remoteShCommand(writeStdinToFileScript('$HOME/f')), home, 'new');

    /* Then */
    assert.equal(readFileSync(path.join(home, 'f'), 'utf8'), 'new');
});

test("ssh's own connection errors are told apart from a command exiting 255", () => {
    /* When */
    const cases = [
        isSshConnectFailure(255, 'ssh: connect to host vm.local port 22: Connection refused\n'),
        isSshConnectFailure(255, 'joris@vm.local: Permission denied (publickey).\n'),
        isSshConnectFailure(255, 'Host key verification failed.\n'),
        isSshConnectFailure(255, 'my script failed\n'),
        isSshConnectFailure(1, 'ssh: connect to host vm.local port 22: Connection refused\n'),
    ];

    /* Then */
    assert.deepEqual(cases, [true, true, true, false, false]);
});

test("the failure message is ssh's last line", () => {
    /* When */
    const message = sshFailureMessage(
        'Warning: something\nssh: Could not resolve hostname vm: nodename nor servname\n',
    );

    /* Then */
    assert.equal(message, 'ssh: Could not resolve hostname vm: nodename nor servname');
});
