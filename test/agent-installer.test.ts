import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentInstallerService} from '../src/application/services/agent-installer-service';
import type {AgentBundles} from '../src/application/services/agent-installer-service';
import {SettingsService} from '../src/application/services/settings-service';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {RemoteRun, SshProvisioner} from '../src/application/ports/ssh-provisioner';
import type {RemoteConfig} from '../src/domain/project/remote-target';
import {remoteProjectPath} from '../src/domain/project/remote-target';
import {defaultHostInstructions} from '../src/domain/agent/host-instructions';
import {AgentBundleBuilder, agentBundleSources} from '../src/infrastructure/ssh/agent-bundle';

const APP_VERSION = '2.12.0';
const remote = {user: 'joris', host: 'vm.local', port: 22, dir: 'work'};
const projectPath = remoteProjectPath(remote);

class MemoryStore implements SettingsStore {
    private readonly values = new Map<string, unknown>();

    public get<T = unknown>(key: string): T | null {
        return (this.values.get(key) as T) ?? null;
    }

    public set(key: string, value: unknown): void {
        this.values.set(key, structuredClone(value));
    }

    public delete(key: string): void {
        this.values.delete(key);
    }
}

interface HostState {
    os?: string;
    arch?: string;
    systemd?: boolean;
    sudo?: boolean;
    agent?: string;
    /** What the linger script answers. */
    linger?: 'yes' | 'enabled' | 'needs-sudo';
    /** Whether the host settings file exists already. */
    hostSettings?: boolean;
    /** A script (matched by a substring) that fails, with its stderr. */
    failing?: {match: string; stderr: string};
}

/** Answers each install script the way a host in `state` would, and records what it was asked. */
class FakeProvisioner implements SshProvisioner {
    public readonly steps: string[] = [];
    public readonly stdins = new Map<string, string>();
    public readonly uploads: {localPath: string; remotePath: string}[] = [];

    constructor(private readonly state: HostState = {}) {}

    public run(_host: RemoteConfig, command: string, options: {stdin?: string | Buffer} = {}): Promise<RemoteRun> {
        const step = classify(command);
        this.steps.push(step);
        if (options.stdin !== undefined) this.stdins.set(step, String(options.stdin));
        if (this.state.failing && command.includes(this.state.failing.match)) {
            return Promise.resolve({code: 1, stdout: '', stderr: this.state.failing.stderr});
        }
        return Promise.resolve({code: 0, stdout: this.answer(step), stderr: ''});
    }

    public upload(_host: RemoteConfig, localPath: string, remotePath: string): Promise<void> {
        this.steps.push('upload');
        this.uploads.push({localPath, remotePath});
        return Promise.resolve();
    }

    private answer(step: string): string {
        const s = this.state;
        switch (step) {
            case 'check':
                return [
                    `os=${s.os ?? 'Linux'}`,
                    `machine=${s.arch === 'arm64' ? 'aarch64' : 'x86_64'}`,
                    `arch=${s.arch ?? 'x64'}`,
                    'libc=glibc',
                    'glibc=2.36',
                    `systemd=${s.systemd === false ? 'no' : 'yes'}`,
                    'linger=no',
                    `sudo=${s.sudo ? 'yes' : 'no'}`,
                    `agent=${s.agent ?? ''}`,
                    'curl=yes',
                    'wget=no',
                    'tar=yes',
                    'xz=yes',
                    'sha256sum=yes',
                ].join('\n');
            case 'node':
                return 'node=installed\n';
            case 'linger':
                return `linger=${s.linger ?? 'enabled'}\n`;
            case 'host-settings':
                return s.hostSettings ? 'written=no\n' : 'written=yes\n';
            case 'start':
            case 'restart':
                return 'socket=ready\n';
            default:
                return '';
        }
    }
}

/** Names an install script by what it does, so a test can assert the sequence. */
function classify(command: string): string {
    if (command.includes('for t in curl wget tar xz sha256sum')) return 'check';
    if (command.includes('nodejs.org/dist')) return 'node';
    if (command.includes('mv -fT')) return 'unpack';
    if (command.includes('enable-linger')) return 'linger';
    if (command.includes('systemctl --user stop')) return 'restart';
    if (command.includes('systemctl --user start')) return 'start';
    if (command.includes('host-settings.json')) return 'host-settings';
    if (command.includes('switchboard-agent.service')) return 'unit';
    if (command.includes('bin/switchboard-agent')) return 'bin';
    if (command.includes('setup.sh')) return 'setup';
    return 'other';
}

class FakeBundles implements AgentBundles {
    public readonly built: string[] = [];

    public build(arch: string, version: string): Promise<string> {
        this.built.push(`${version}/${arch}`);
        return Promise.resolve(`/tmp/agent-${version}-${arch}.tar`);
    }
}

const silent = {debug() {}, info() {}, warn() {}, error() {}};

function setup(state: HostState = {}, sessions = [{sessionId: 's1', kind: 'claude', created: '2026-01-01T00:00:00Z'}]) {
    const settings = new SettingsService(new MemoryStore());
    settings.addRemoteProject({...remote, sessions});
    const provisioner = new FakeProvisioner(state);
    const bundles = new FakeBundles();
    const installer = new AgentInstallerService({
        provisioner,
        settings,
        bundles,
        appVersion: APP_VERSION,
        log: silent,
        clock: {now: () => Date.parse('2026-11-03T10:00:00Z')},
    });
    return {settings, provisioner, bundles, installer};
}

test('a fresh host gets the full install sequence', async () => {
    /* Given */
    const {installer, provisioner, bundles} = setup();
    const progress: string[] = [];

    /* When */
    const result = await installer.install(projectPath, (line) => progress.push(line));

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(provisioner.steps, [
        'check',
        'node',
        'upload',
        'unpack',
        'bin',
        'unit',
        'setup',
        'host-settings',
        'linger',
        // A restart even on a fresh host: an agent left running by a broken
        // install would otherwise go on serving the old code.
        'restart',
    ]);
    assert.deepEqual(bundles.built, ['2.12.0/x64']);
    assert.deepEqual(provisioner.uploads, [
        {localPath: '/tmp/agent-2.12.0-x64.tar', remotePath: '$HOME/.switchboard/upload/agent-2.12.0-x64.tar'},
    ]);
    assert.ok(progress.includes('Installing Node 22.22.2…'));
    assert.ok(progress.includes('Starting the agent…'));
});

test('a fresh host is marked as an agent host, keeping its sessions', async () => {
    /* Given */
    const {installer, settings} = setup();

    /* When */
    await installer.install(projectPath);

    /* Then */
    const project = settings.findRemoteProject(projectPath);
    assert.deepEqual(project?.agent, {version: APP_VERSION, installedAt: '2026-11-03T10:00:00.000Z'});
    assert.deepEqual(
        project?.sessions?.map((s) => s.sessionId),
        ['s1'],
    );
});

test('the arm64 bundle goes to an arm64 host', async () => {
    /* Given */
    const {installer, bundles} = setup({arch: 'arm64'});

    /* When */
    await installer.install(projectPath);

    /* Then */
    assert.deepEqual(bundles.built, ['2.12.0/arm64']);
});

test('the same version only makes sure the service runs', async () => {
    /* Given */
    const {installer, provisioner, bundles, settings} = setup({agent: APP_VERSION});

    /* When */
    const result = await installer.install(projectPath);

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(provisioner.steps, ['check', 'start']);
    assert.deepEqual(bundles.built, []);
    assert.equal(settings.findRemoteProject(projectPath)?.agent?.version, APP_VERSION);
});

test('an older version is upgraded, restarted, and keeps the host settings', async () => {
    /* Given */
    const {installer, provisioner} = setup({agent: '2.11.9', hostSettings: true});
    const progress: string[] = [];

    /* When */
    const result = await installer.install(projectPath, (line) => progress.push(line));

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(provisioner.steps.slice(-3), ['host-settings', 'linger', 'restart']);
    assert.ok(progress.includes('Upgrading the agent from 2.11.9 to 2.12.0.'));
    assert.ok(progress.includes('Kept the host settings already there.'));
});

test('macOS is refused before anything is installed', async () => {
    /* Given */
    const {installer, provisioner, settings} = setup({os: 'Darwin'});

    /* When */
    const result = await installer.install(projectPath);

    /* Then */
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Linux only/);
    assert.deepEqual(provisioner.steps, ['check']);
    assert.equal(settings.findRemoteProject(projectPath)?.agent, undefined);
});

test('a host without systemd is refused', async () => {
    /* Given */
    const {installer, provisioner} = setup({systemd: false});

    /* When */
    const result = await installer.install(projectPath);

    /* Then */
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /systemd user instance/);
    assert.deepEqual(provisioner.steps, ['check']);
});

test('a host with sudo gets the instructions that mention sudo', async () => {
    /* Given */
    const {installer, provisioner} = setup({sudo: true});

    /* When */
    await installer.install(projectPath);

    /* Then */
    const written = JSON.parse(provisioner.stdins.get('host-settings') ?? '{}');
    assert.deepEqual(written, {
        instructions: defaultHostInstructions({sudo: true}),
        copyConfig: true,
        baseFolder: '~/projects',
    });
    assert.match(written.instructions, /sudo is available/);
});

test('a host without sudo gets the instructions without it', async () => {
    /* Given */
    const {installer, provisioner} = setup({sudo: false});

    /* When */
    await installer.install(projectPath);

    /* Then */
    const written = JSON.parse(provisioner.stdins.get('host-settings') ?? '{}');
    assert.equal(written.instructions, defaultHostInstructions({sudo: false}));
    assert.doesNotMatch(written.instructions, /sudo/);
});

test('lingering that needs sudo reports the command and still installs', async () => {
    /* Given */
    const {installer, provisioner} = setup({linger: 'needs-sudo'});
    const progress: string[] = [];

    /* When */
    const result = await installer.install(projectPath, (line) => progress.push(line));

    /* Then */
    assert.deepEqual(result, {ok: true, lingerCommand: 'sudo loginctl enable-linger joris'});
    assert.equal(provisioner.steps[provisioner.steps.length - 1], 'restart');
    assert.ok(progress.some((line) => line.includes('sudo loginctl enable-linger joris')));
});

test('the agent command, unit and setup script are written from stdin', async () => {
    /* Given */
    const {installer, provisioner} = setup();

    /* When */
    await installer.install(projectPath);

    /* Then */
    assert.match(provisioner.stdins.get('bin') ?? '', /^#!\/bin\/sh/);
    assert.match(provisioner.stdins.get('unit') ?? '', /ExecStart=%h\/\.switchboard\/bin\/switchboard-agent serve/);
    assert.match(provisioner.stdins.get('setup') ?? '', /gh auth login/);
});

test('a failing step is named, with what the host said, and nothing is marked', async () => {
    /* Given */
    const {installer, provisioner, settings} = setup({
        failing: {match: 'nodejs.org', stderr: 'curl: (6) Could not resolve host'},
    });

    /* When */
    const result = await installer.install(projectPath);

    /* Then */
    assert.equal(result.ok, false);
    assert.match(
        result.error ?? '',
        /^Installing Node 22\.22\.2 failed \(exit 1\): curl: \(6\) Could not resolve host$/,
    );
    assert.deepEqual(provisioner.steps, ['check', 'node']);
    assert.equal(settings.findRemoteProject(projectPath)?.agent, undefined);
});

test('ssh failing to connect fails the host check step', async () => {
    /* Given */
    const {installer, provisioner} = setup();
    provisioner.run = () => Promise.reject(new Error('Could not connect to joris@vm.local: Connection refused'));

    /* When */
    const result = await installer.install(projectPath);

    /* Then */
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Checking the host failed: Could not connect to joris@vm.local: Connection refused');
});

test('a project that is not a configured remote is refused', async () => {
    /* Given */
    const {installer} = setup();

    /* When */
    const result = await installer.install('ssh://someone@else');

    /* Then */
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not a configured SSH remote/);
});

test('status answers from settings, without ssh', async () => {
    /* Given */
    const {installer, provisioner, settings} = setup();
    const before = await installer.status(projectPath);
    settings.markAgentInstalled(projectPath, '2.11.0', '2026-01-01T00:00:00Z');

    /* When */
    const after = await installer.status(projectPath);

    /* Then */
    assert.deepEqual(before, {installed: null, current: false, connected: false});
    assert.deepEqual(after, {installed: '2.11.0', current: false, connected: false});
    assert.deepEqual(provisioner.steps, []);
});

test('markAgentInstalled keeps the remote sessions and connection info', () => {
    /* Given */
    const settings = new SettingsService(new MemoryStore());
    const sessions = [
        {sessionId: 'a', kind: 'claude', created: '2026-01-01T00:00:00Z', lastOpened: '2026-01-02T00:00:00Z'},
        {sessionId: 'b', kind: 'shell', created: '2026-01-03T00:00:00Z'},
    ];
    settings.addRemoteProject({...remote, sessions});

    /* When */
    const marked = settings.markAgentInstalled(projectPath, '2.12.0', '2026-11-03T10:00:00Z');

    /* Then */
    assert.equal(marked, true);
    assert.deepEqual(settings.findRemoteProject(projectPath), {
        ...remote,
        sessions,
        agent: {version: '2.12.0', installedAt: '2026-11-03T10:00:00Z'},
    });
});

test('markAgentInstalled marks every remote on the same host, and no other host', () => {
    /* Given */
    const settings = new SettingsService(new MemoryStore());
    settings.addRemoteProject(remote);
    settings.addRemoteProject({...remote, dir: '~/apps/other'});
    settings.addRemoteProject({...remote, host: 'other-vm.local'});

    /* When */
    settings.markAgentInstalled(projectPath, '2.12.0', '2026-11-03T10:00:00Z');

    /* Then */
    const versions = (settings.global().remoteProjects ?? []).map(
        (r) => `${r.host}:${r.dir ?? ''}=${r.agent?.version ?? '-'}`,
    );
    assert.deepEqual(versions.sort(), [
        `other-vm.local:${remote.dir ?? ''}=-`,
        `vm.local:${remote.dir ?? ''}=2.12.0`,
        'vm.local:~/apps/other=2.12.0',
    ]);
});

test('markAgentInstalled answers false for a remote that is gone', () => {
    /* Given */
    const settings = new SettingsService(new MemoryStore());

    /* When */
    const marked = settings.markAgentInstalled(projectPath, '2.12.0');

    /* Then */
    assert.equal(marked, false);
});

// ── The bundle ──

function bundleFixture(): {root: string; sources: ReturnType<typeof agentBundleSources>} {
    const root = mkdtempSync(path.join(tmpdir(), 'sb-bundle-'));
    mkdirSync(path.join(root, 'app/agent'), {recursive: true});
    writeFileSync(path.join(root, 'app/agent/agent.js'), 'agent');
    writeFileSync(path.join(root, 'app/agent/connect.js'), 'connect');
    writeFileSync(path.join(root, 'app/agent/notes.txt'), 'not shipped');
    const pty = path.join(root, 'build/agent-pty/linux-x64/node-pty');
    mkdirSync(path.join(pty, 'lib'), {recursive: true});
    mkdirSync(path.join(pty, 'prebuilds/linux-x64'), {recursive: true});
    writeFileSync(path.join(pty, 'package.json'), '{"name":"node-pty","main":"./lib/index.js"}');
    writeFileSync(path.join(pty, 'lib/index.js'), 'index');
    writeFileSync(path.join(pty, 'prebuilds/linux-x64/pty.node'), 'addon');
    const sources = agentBundleSources({isPackaged: false, resourcesPath: '/nope', appRoot: root, tmpDir: root});
    return {root, sources};
}

test('the bundle holds the agent scripts and node-pty laid out for require', async () => {
    /* Given */
    const {root, sources} = bundleFixture();
    const out = path.join(root, 'out');
    mkdirSync(out);

    /* When */
    const tarPath = await new AgentBundleBuilder(sources).build('x64', '2.12.0');

    /* Then */
    execFileSync('tar', ['-xf', tarPath, '-C', out]);
    const listing = execFileSync('tar', ['-tf', tarPath]).toString().trim().split('\n').sort();
    assert.deepEqual(listing, [
        'agent.js',
        'connect.js',
        'node_modules/node-pty/lib/index.js',
        'node_modules/node-pty/package.json',
        'node_modules/node-pty/prebuilds/linux-x64/pty.node',
    ]);
    assert.equal(readFileSync(path.join(out, 'node_modules/node-pty/prebuilds/linux-x64/pty.node'), 'utf8'), 'addon');
});

test('the bundle refuses an architecture whose node-pty build is missing', async () => {
    /* Given */
    const {sources} = bundleFixture();

    /* When */
    const building = new AgentBundleBuilder(sources).build('arm64', '2.12.0');

    /* Then */
    await assert.rejects(building, /Linux arm64 node-pty build is missing/);
});

test('a packaged app takes the bundle from its resources', () => {
    /* When */
    const sources = agentBundleSources({
        isPackaged: true,
        resourcesPath: '/Applications/Switchboard.app/Contents/Resources',
        appRoot: '/ignored',
        tmpDir: '/tmp',
    });

    /* Then */
    assert.equal(sources.agentDir, '/Applications/Switchboard.app/Contents/Resources/agent');
    assert.equal(sources.ptyRoot, '/Applications/Switchboard.app/Contents/Resources/agent-pty');
});
