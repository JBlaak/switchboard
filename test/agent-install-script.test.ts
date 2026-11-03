import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    agentBinScript,
    agentUnitFile,
    agentUnpackScript,
    agentUploadPath,
    compareVersions,
    hostCheckProblem,
    hostCheckScript,
    lingerCommand,
    lingerScript,
    nodeInstallScript,
    parseHostCheck,
    safeVersion,
    startServiceScript,
    writeFileIfMissingScript,
} from '../src/domain/agent/install-script';
import type {HostCheck} from '../src/domain/agent/install-script';
import {AGENT_NODE} from '../src/domain/agent/layout';
import {SETUP_SCRIPT_FILE, setupScript, setupTerminalCommand} from '../src/domain/agent/setup-script';
import {tarArchive} from '../src/domain/agent/tar';

/** Fails when `script` isn't valid sh. */
function assertParses(script: string): void {
    execFileSync('/bin/sh', ['-n'], {input: script});
}

function runSh(script: string, home: string, stdin = ''): string {
    return execFileSync('/bin/sh', ['-c', script], {
        env: {PATH: process.env.PATH, HOME: home},
        input: stdin,
    }).toString();
}

function hasCommand(name: string): boolean {
    try {
        execFileSync('/bin/sh', ['-c', `command -v ${name}`], {stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
}

const linuxHost: HostCheck = {
    os: 'Linux',
    machine: 'x86_64',
    arch: 'x64',
    libc: 'glibc',
    glibcVersion: '2.35',
    systemdUser: true,
    linger: false,
    sudo: true,
    agentVersion: null,
    curl: true,
    wget: false,
    tar: true,
    xz: true,
    sha256sum: true,
};

// ── Host check ──

test('the host check is valid sh and reports every key', () => {
    /* When */
    const script = hostCheckScript();

    /* Then */
    assertParses(script);
    for (const key of ['os', 'arch', 'machine', 'libc', 'glibc', 'systemd', 'linger', 'sudo', 'agent']) {
        assert.match(script, new RegExp(`echo "?${key}=`), key);
    }
    assert.match(script, /for t in curl wget tar xz sha256sum/);
    assert.match(script, /"\$HOME"\/'\.switchboard\/bin\/switchboard-agent' version/);
});

test('the host check maps uname -m to the agent architectures', () => {
    /* When */
    const script = hostCheckScript();

    /* Then */
    assert.match(script, /x86_64\|amd64\) a=x64/);
    assert.match(script, /aarch64\|arm64\) a=arm64/);
});

test("the host check runs on this Mac and answers that it isn't Linux", () => {
    /* Given */
    const home = mkdtempSync(path.join(tmpdir(), 'sb-check-'));

    /* When */
    const check = parseHostCheck(runSh(hostCheckScript(), home));

    /* Then */
    assert.equal(check.os, process.platform === 'darwin' ? 'Darwin' : 'Linux');
    assert.equal(check.agentVersion, null);
    assert.equal(check.tar, true);
});

test('parsing the host check reads key=value lines and ignores the rest', () => {
    /* Given */
    const stdout = [
        'Welcome to Ubuntu!',
        'os=Linux',
        'machine=aarch64',
        'arch=arm64',
        'libc=glibc',
        'glibc=2.39',
        'systemd=yes',
        'linger=no',
        'sudo=no',
        'agent=2.11.8',
        'curl=no',
        'wget=yes',
        'tar=yes',
        'xz=yes',
        'sha256sum=yes',
    ].join('\r\n');

    /* When */
    const check = parseHostCheck(stdout);

    /* Then */
    assert.deepEqual(check, {
        os: 'Linux',
        machine: 'aarch64',
        arch: 'arm64',
        libc: 'glibc',
        glibcVersion: '2.39',
        systemdUser: true,
        linger: false,
        sudo: false,
        agentVersion: '2.11.8',
        curl: false,
        wget: true,
        tar: true,
        xz: true,
        sha256sum: true,
    });
});

test('a Linux x64 host with systemd and the tools passes', () => {
    /* When */
    const problem = hostCheckProblem(linuxHost);

    /* Then */
    assert.equal(problem, null);
});

test('macOS is refused as Linux only', () => {
    /* When */
    const problem = hostCheckProblem({...linuxHost, os: 'Darwin'});

    /* Then */
    assert.match(problem ?? '', /Linux only.*Darwin/);
});

test('an unsupported architecture is refused', () => {
    /* When */
    const problem = hostCheckProblem({...linuxHost, arch: null, machine: 'riscv64'});

    /* Then */
    assert.match(problem ?? '', /x64 and arm64.*riscv64/);
});

test('musl and an old glibc are refused', () => {
    /* When */
    const musl = hostCheckProblem({...linuxHost, libc: 'musl', glibcVersion: null});
    const old = hostCheckProblem({...linuxHost, glibcVersion: '2.27'});

    /* Then */
    assert.match(musl ?? '', /musl/);
    assert.match(old ?? '', /glibc 2\.27.*2\.28/);
});

test('no systemd user instance is refused', () => {
    /* When */
    const problem = hostCheckProblem({...linuxHost, systemdUser: false});

    /* Then */
    assert.match(problem ?? '', /systemd user instance/);
});

test('missing download and unpack tools are named, with what to install', () => {
    /* When */
    const problem = hostCheckProblem({...linuxHost, curl: false, wget: false, xz: false});

    /* Then */
    assert.match(problem ?? '', /missing curl \(or wget\) and xz/);
    assert.match(problem ?? '', /apt install/);
});

test('wget alone is enough to download', () => {
    /* When */
    const problem = hostCheckProblem({...linuxHost, curl: false, wget: true});

    /* Then */
    assert.equal(problem, null);
});

test('versions compare numerically', () => {
    /* When */
    const results = [compareVersions('2.28', '2.28'), compareVersions('2.9', '2.28'), compareVersions('2.31', '2.28')];

    /* Then */
    assert.ok(results[0] === 0 && results[1] < 0 && results[2] > 0);
});

// ── Node ──

test('the Node install downloads the pinned version and checks its sum', () => {
    /* When */
    const script = nodeInstallScript('arm64');

    /* Then */
    assertParses(script);
    assert.match(
        script,
        new RegExp(
            `https://nodejs\\.org/dist/v${AGENT_NODE.version}/node-v${AGENT_NODE.version}-linux-arm64\\.tar\\.xz`,
        ),
    );
    assert.match(script, new RegExp(`expected='${AGENT_NODE.sha256.arm64}'`));
    assert.match(script, /sha256sum "\$work\/node\.tar\.xz"/);
    assert.match(script, /if \[ "\$actual" != "\$expected" \]; then[\s\S]*Refusing[\s\S]*exit 3/);
});

test('the Node install skips when that Node is already unpacked', () => {
    /* When */
    const script = nodeInstallScript('x64');

    /* Then */
    assert.match(script, new RegExp(`dir="\\$HOME"/'\\.switchboard/node/${AGENT_NODE.version.replace(/\./g, '\\.')}'`));
    assert.match(script, /if \[ -x "\$dir\/bin\/node" \]; then echo node=present; exit 0; fi/);
});

test('the Node install refuses a download whose sum does not match', () => {
    /* Given */
    const home = mkdtempSync(path.join(tmpdir(), 'sb-node-'));
    const bin = mkdtempSync(path.join(tmpdir(), 'sb-bin-'));
    // A fake curl that "downloads" the wrong bytes, so the check runs for real.
    writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\necho tampered > "$2"\n', {
        mode: 0o755,
    });
    // macOS has shasum but no sha256sum; Linux has both.
    if (!hasCommand('sha256sum')) {
        writeFileSync(
            path.join(bin, 'sha256sum'),
            '#!/bin/sh\nprintf "%s  %s\\n" "$(shasum -a 256 "$1" | cut -d " " -f 1)" "$1"\n',
            {mode: 0o755},
        );
    }

    /* When */
    let code = 0;
    let stderr = '';
    try {
        execFileSync('/bin/sh', ['-c', nodeInstallScript('x64')], {
            env: {PATH: `${bin}:${process.env.PATH}`, HOME: home},
            stdio: 'pipe',
        });
    } catch (err) {
        const e = err as {status: number; stderr: Buffer};
        code = e.status;
        stderr = e.stderr.toString();
    }

    /* Then */
    assert.equal(code, 3);
    assert.match(stderr, /Refusing to install it/);
});

test('the Node install refuses a malformed sum', () => {
    /* When */
    const build = () => nodeInstallScript('x64', {version: '22.22.2', sha256: 'abc'});

    /* Then */
    assert.throws(build, /Not a SHA-256/);
});

test('the pinned Node sums are real SHA-256 sums', () => {
    /* When */
    const sums = Object.values(AGENT_NODE.sha256);

    /* Then */
    for (const sum of sums) assert.match(sum, /^[0-9a-f]{64}$/);
});

// ── Agent ──

test('the unpack script unpacks beside the target, then switches current atomically', () => {
    /* When */
    const script = agentUnpackScript('2.12.0', agentUploadPath('2.12.0', 'x64'));

    /* Then */
    assertParses(script);
    assert.match(script, /dest="\$HOME"\/'\.switchboard\/agent\/2\.12\.0'/);
    assert.match(script, /bundle="\$HOME"\/'\.switchboard\/upload\/agent-2\.12\.0-x64\.tar'/);
    assert.match(script, /tar -xf "\$bundle" -C "\$dest\.partial"/);
    assert.match(script, /ln -sfn '2\.12\.0' "\$links\/current\.next"/);
    assert.match(script, /mv -fT "\$links\/current\.next" "\$links\/current"/);
});

test('a version that is not x.y.z never reaches a script', () => {
    /* When */
    const build = () => agentUnpackScript("1.0.0'; rm -rf ~", '$HOME/x.tar');

    /* Then */
    assert.throws(build, /Not a version/);
    assert.equal(safeVersion('2.11.9'), '2.11.9');
});

test('the agent command runs the pinned Node on current/connect.js and current/agent.js', () => {
    /* When */
    const script = agentBinScript();

    /* Then */
    assertParses(script);
    assert.match(script, /^#!\/bin\/sh\n/);
    assert.match(
        script,
        new RegExp(`node="\\$HOME"/'\\.switchboard/node/${AGENT_NODE.version.replace(/\./g, '\\.')}/bin/node'`),
    );
    assert.match(script, /connect\|version\) exec "\$node" "\$current\/connect\.js" "\$@"/);
    assert.match(script, /serve\) shift; exec "\$node" "\$current\/agent\.js"/);
});

test('the agent command answers version through connect.js', () => {
    /* Given */
    const home = mkdtempSync(path.join(tmpdir(), 'sb-bin-'));
    const nodeBin = path.join(home, '.switchboard/node', AGENT_NODE.version, 'bin');
    const current = path.join(home, '.switchboard/agent/current');
    execFileSync('mkdir', ['-p', nodeBin, current]);
    // A stand-in node that prints what it was asked to run.
    writeFileSync(path.join(nodeBin, 'node'), '#!/bin/sh\necho "node $*"\n', {mode: 0o755});
    const bin = path.join(home, 'switchboard-agent');
    writeFileSync(bin, agentBinScript(), {mode: 0o755});

    /* When */
    const out = execFileSync(bin, ['version'], {env: {PATH: process.env.PATH, HOME: home}}).toString();

    /* Then */
    assert.equal(out, `node ${current}/connect.js version\n`);
});

test('the unit starts the agent through its command, restarts on failure and logs to the journal', () => {
    /* When */
    const unit = agentUnitFile();

    /* Then */
    assert.match(unit, /^ExecStart=%h\/\.switchboard\/bin\/switchboard-agent serve$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, /^StandardOutput=journal$/m);
    assert.match(unit, /^StandardError=journal$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
});

// ── Lingering and the service ──

test('lingering is tried without sudo, then with password-less sudo, then reported', () => {
    /* When */
    const script = lingerScript();

    /* Then */
    assertParses(script);
    const plain = script.indexOf('loginctl enable-linger "$u"');
    const sudo = script.indexOf('sudo -n loginctl enable-linger "$u"');
    const report = script.indexOf('echo linger=needs-sudo');
    assert.ok(plain >= 0 && plain < sudo && sudo < report);
});

test('the linger command for the setup terminal names the user', () => {
    /* When */
    const command = lingerCommand('joris');

    /* Then */
    assert.equal(command, 'sudo loginctl enable-linger joris');
    assert.throws(() => lingerCommand('a b'));
});

test('starting the service enables it and waits about 10 s for the socket', () => {
    /* When */
    const script = startServiceScript({restart: false});

    /* Then */
    assertParses(script);
    assert.match(script, /systemctl --user daemon-reload/);
    assert.match(script, /systemctl --user enable --quiet "\$unit"/);
    assert.match(script, /systemctl --user start "\$unit"/);
    assert.match(script, /sock="\$HOME"\/'\.switchboard\/agent\.sock'/);
    assert.match(script, /while \[ ! -S "\$sock" \]/);
    assert.match(script, /-ge 20/);
    assert.doesNotMatch(script, /systemctl --user stop/);
});

test('an upgrade stops the old agent and clears its socket before starting', () => {
    /* When */
    const script = startServiceScript({restart: true});

    /* Then */
    assertParses(script);
    assert.ok(script.indexOf('systemctl --user stop') < script.indexOf('systemctl --user start'));
    assert.match(script, /stop "\$unit" 2>\/dev\/null \|\| true; rm -f "\$sock"/);
});

// ── Files ──

test('write-if-missing writes once and keeps what is there afterwards', () => {
    /* Given */
    const home = mkdtempSync(path.join(tmpdir(), 'sb-settings-'));
    const script = writeFileIfMissingScript('$HOME/.switchboard/host-settings.json');

    /* When */
    const first = runSh(script, home, '{"a":1}');
    const second = runSh(script, home, '{"a":2}');

    /* Then */
    assert.equal(first.trim(), 'written=yes');
    assert.equal(second.trim(), 'written=no');
    assert.equal(readFileSync(path.join(home, '.switchboard/host-settings.json'), 'utf8'), '{"a":1}');
});

// ── Setup script ──

test('the setup script is valid sh and the terminal types one line to run it', () => {
    /* When */
    const script = setupScript();

    /* Then */
    assertParses(script);
    assert.equal(SETUP_SCRIPT_FILE, '$HOME/.switchboard/setup.sh');
    assert.equal(setupTerminalCommand(), 'sh "$HOME/.switchboard/setup.sh"');
});

test('the setup script installs each tool only when it is missing', () => {
    /* When */
    const script = setupScript();

    /* Then */
    assert.match(script, /if have git; then ok/);
    assert.match(script, /if have gh; then ok/);
    assert.match(script, /if have claude; then ok/);
    assert.match(script, /fetch https:\/\/claude\.ai\/install\.sh \| bash/);
});

test('the setup script installs gh from the official repository, or the release tarball without sudo', () => {
    /* When */
    const script = setupScript();

    /* Then */
    assert.match(script, /https:\/\/cli\.github\.com\/packages stable main/);
    assert.match(script, /https:\/\/cli\.github\.com\/packages\/rpm\/gh-cli\.repo/);
    assert.match(script, /releases\/download\/v\$\{tag\}\/\$\{name\}\.tar\.gz/);
    assert.match(script, /\$HOME\/\.local\/bin\/gh/);
});

test('the setup script signs in only where that is not done', () => {
    /* When */
    const script = setupScript();

    /* Then */
    assert.match(script, /elif gh auth status >\/dev\/null 2>&1; then ok "gh is signed in"\nelse[\s\S]*gh auth login/);
    assert.match(script, /elif claude_signed_in; then ok[\s\S]*\n {4}claude\n/);
});

test('the setup script ends with a summary line per tool', () => {
    /* When */
    const summary = setupScript().split('step "Summary"')[1];

    /* Then */
    assert.match(summary, /ok "git"/);
    assert.match(summary, /ok "gh \(signed in\)"/);
    assert.match(summary, /ok "claude \(signed in\)"/);
});

test('the setup script, re-run with every tool present and signed in, changes nothing', () => {
    /* Given */
    const home = mkdtempSync(path.join(tmpdir(), 'sb-setup-'));
    const bin = path.join(home, 'bin');
    execFileSync('mkdir', ['-p', bin, path.join(home, '.claude')]);
    writeFileSync(path.join(home, '.claude/.credentials.json'), '{}');
    const log = path.join(home, 'calls.log');
    for (const tool of ['git', 'gh', 'claude']) {
        writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\necho "${tool} 1.0"\n`, {
            mode: 0o755,
        });
    }
    for (const tool of ['sudo', 'apt-get', 'curl']) {
        writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "UNEXPECTED ${tool} $*" >> "${log}"\nexit 1\n`, {
            mode: 0o755,
        });
    }

    /* When */
    const out = execFileSync('/bin/sh', ['-c', setupScript()], {
        env: {PATH: `${bin}:/usr/bin:/bin`, HOME: home},
    }).toString();

    /* Then */
    assert.doesNotMatch(readFileSync(log, 'utf8'), /UNEXPECTED|auth login/);
    assert.match(out, /✓ git\n✓ gh \(signed in\)\n✓ claude \(signed in\)\n$/);
});

// ── Tar ──

test('the bundle tar unpacks with the system tar, modes and long paths intact', () => {
    /* Given */
    const dir = mkdtempSync(path.join(tmpdir(), 'sb-tar-'));
    const long = 'node_modules/node-pty/' + 'deep/'.repeat(20) + 'file.js';
    const archive = tarArchive([
        {path: 'agent.js', data: new TextEncoder().encode('console.log(1)\n'), mode: 0o644, mtime: 1_700_000_000},
        {path: 'bin/run', data: new TextEncoder().encode('#!/bin/sh\n'), mode: 0o755, mtime: 1_700_000_000},
        {path: long, data: new TextEncoder().encode('x'), mode: 0o644, mtime: 1_700_000_000},
    ]);
    writeFileSync(path.join(dir, 'a.tar'), archive);

    /* When */
    execFileSync('tar', ['-xf', 'a.tar'], {cwd: dir});

    /* Then */
    assert.equal(readFileSync(path.join(dir, 'agent.js'), 'utf8'), 'console.log(1)\n');
    assert.equal(readFileSync(path.join(dir, long), 'utf8'), 'x');
    assert.equal(statSync(path.join(dir, 'bin/run')).mode & 0o777, 0o755);
});

test('the bundle tar refuses paths outside the archive', () => {
    /* When */
    const build = () => tarArchive([{path: '../x', data: new Uint8Array(), mode: 0o644, mtime: 0}]);

    /* Then */
    assert.throws(build, /Not a relative path/);
});
