import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CLAUDE_DIR_PLACEHOLDER} from '../src/domain/agent/config-copy';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    HostConfig,
    parseVersion,
    type ClaudeConfigDir,
    type CommandResult,
    type CommandRunner,
    type HostSettingsFile,
} from '../src/application/services/agent-host/host-config';
import {DEFAULT_BASE_FOLDER, defaultHostInstructions} from '../src/domain/agent/host-instructions';
import type {AgentMessage, ConfigFile, HostSettings} from '../src/domain/agent/protocol';
import {expandHome} from '../src/infrastructure/agent/home-path';
import {NodeClaudeConfigDir} from '../src/infrastructure/agent/node-claude-config-dir';
import {NodeCommandRunner} from '../src/infrastructure/agent/node-command-runner';
import {NodeHostSettingsFile} from '../src/infrastructure/agent/node-host-settings-file';
import {linkPair} from './support/agent-link';
import {silentLog} from './support/fakes';

/**
 * The agent's host config, driven through an in-memory link with an in-memory
 * settings file, a fake command runner and an in-memory `~/.claude`; then the
 * Node adapters on a temp dir.
 */

const DEFAULTS: HostSettings = {
    instructions: defaultHostInstructions({sudo: false}),
    copyConfig: true,
    baseFolder: DEFAULT_BASE_FOLDER,
};

function memoryFile(text: string | null = null): HostSettingsFile & {text: string | null} {
    return {
        text,
        read() {
            return this.text;
        },
        write(next) {
            this.text = next;
        },
    };
}

/** Answers each `command args…` with a canned result; anything else is not installed. */
function fakeCommands(results: Record<string, Partial<CommandResult>>): CommandRunner & {ran: string[]} {
    const ran: string[] = [];
    return {
        ran,
        run(command, args) {
            const line = [command, ...args].join(' ');
            ran.push(line);
            const result = results[line];
            return Promise.resolve(
                result ? {exitCode: 0, stdout: '', stderr: '', ...result} : {exitCode: null, stdout: '', stderr: ''},
            );
        },
    };
}

function memoryClaudeDir(
    initial: Record<string, string> = {},
): ClaudeConfigDir & {files: Map<string, {text: string; mode: number}>} {
    const files = new Map(Object.entries(initial).map(([p, text]) => [p, {text, mode: 0o600}]));
    return {
        root: '/home/dev/.claude',
        files,
        exists: (p) => files.has(p),
        write: (p, content, mode) => void files.set(p, {text: Buffer.from(content).toString('utf8'), mode}),
        remove: (p) => void files.delete(p),
    };
}

function harness(
    options: {
        file?: string | null;
        commands?: Record<string, Partial<CommandResult>>;
        claude?: Record<string, string>;
    } = {},
) {
    const file = memoryFile(options.file ?? null);
    const commands = fakeCommands(options.commands ?? {});
    const claudeDir = memoryClaudeDir(options.claude);
    const part = new HostConfig({settingsFile: file, commands, claudeDir, log: silentLog});
    const pair = linkPair();
    const received: AgentMessage[] = [];
    pair.mac.onMessage((message) => received.push(message));
    pair.agent.onMessage((message) => {
        if (
            message.type === 'get-host-settings' ||
            message.type === 'set-host-settings' ||
            message.type === 'check-tools' ||
            message.type === 'copy-config'
        )
            part.handle(pair.agent, message);
    });
    part.clientConnected(pair.agent);
    return {part, file, commands, claudeDir, pair, received};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const file = (p: string, text: string, mode = 0o644): ConfigFile => ({
    path: p,
    contentBase64: Buffer.from(text).toString('base64'),
    mode,
});

// ── Settings ──

test('a host with no settings file has the defaults', () => {
    /* Given */
    const h = harness();

    /* When */
    h.pair.mac.send({type: 'get-host-settings', requestId: 'r1'});

    /* Then */
    assert.deepEqual(h.received, [{type: 'host-settings', requestId: 'r1', settings: DEFAULTS}]);
    assert.deepEqual(h.part.current(), DEFAULTS);
});

test('a corrupt settings file gives the defaults', () => {
    /* Given */
    const h = harness({file: '{not json'});

    /* When */
    const settings = h.part.current();

    /* Then */
    assert.deepEqual(settings, DEFAULTS);
});

test('a saved file keeps its well-typed fields over the defaults', () => {
    /* Given */
    const h = harness({
        file: JSON.stringify({instructions: 'Mine.', copyConfig: 'yes', baseFolder: '~/work', extra: 1}),
    });

    /* When */
    const settings = h.part.current();

    /* Then */
    assert.deepEqual(settings, {instructions: 'Mine.', copyConfig: true, baseFolder: '~/work'});
});

test('setting merges only the known fields, saves, and answers with all of them', () => {
    /* Given */
    const h = harness();

    /* When */
    h.pair.mac.send({
        type: 'set-host-settings',
        requestId: 'r2',
        settings: {copyConfig: false, ...({unknown: 'x'} as Partial<HostSettings>)},
    });

    /* Then */
    const expected = {...DEFAULTS, copyConfig: false};
    assert.deepEqual(h.received, [{type: 'host-settings', requestId: 'r2', settings: expected}]);
    assert.deepEqual(JSON.parse(h.file.text ?? ''), expected);
    assert.deepEqual(h.part.current(), expected);
});

test('a settings save that fails still changes the settings for this run', () => {
    /* Given */
    const h = harness();
    h.file.write = () => {
        throw new Error('read-only');
    };

    /* When */
    h.pair.mac.send({type: 'set-host-settings', requestId: 'r3', settings: {instructions: 'New.'}});

    /* Then */
    assert.equal(h.part.current().instructions, 'New.');
    assert.equal(h.received[0]?.type, 'host-settings');
});

// ── Schedule folders (stage 5) ──

test('schedule folders are saved, answered and read back after a restart', () => {
    /* Given */
    const h = harness();

    /* When */
    h.pair.mac.send({
        type: 'set-host-settings',
        requestId: 's1',
        settings: {scheduleDirs: ['~/projects/app/', '/srv/work//api', '~/projects/app']},
    });

    /* Then */
    const expected = {...DEFAULTS, scheduleDirs: ['~/projects/app', '/srv/work/api']};
    assert.deepEqual(h.received, [{type: 'host-settings', requestId: 's1', settings: expected}]);
    assert.deepEqual(JSON.parse(h.file.text ?? ''), expected);
    assert.deepEqual(harness({file: h.file.text}).part.current(), expected);
});

test('an empty schedule folder list is saved as none', () => {
    /* Given */
    const h = harness({file: JSON.stringify({scheduleDirs: ['~/projects/app']})});

    /* When */
    h.pair.mac.send({type: 'set-host-settings', requestId: 's2', settings: {scheduleDirs: []}});

    /* Then */
    assert.deepEqual(h.part.current().scheduleDirs, []);
});

for (const bad of ['', '   ', 'projects/app', '~', '/', '~/projects/../.ssh', '/srv/\0x', '~user/app']) {
    test(`a schedule folder list holding ${JSON.stringify(bad)} is refused whole`, () => {
        /* Given */
        const h = harness({file: JSON.stringify({scheduleDirs: ['~/projects/app']})});

        /* When */
        h.pair.mac.send({
            type: 'set-host-settings',
            requestId: 's3',
            settings: {scheduleDirs: ['~/projects/other', bad], copyConfig: false},
        });

        /* Then */
        const settings = h.part.current();
        assert.deepEqual(settings.scheduleDirs, ['~/projects/app']);
        assert.equal(settings.copyConfig, false);
        assert.deepEqual(h.received[0], {type: 'host-settings', requestId: 's3', settings});
    });
}

test('bad schedule folders in the file are ignored', () => {
    /* Given */
    const h = harness({file: JSON.stringify({scheduleDirs: ['relative/path']})});

    /* When */
    const settings = h.part.current();

    /* Then */
    assert.equal(settings.scheduleDirs, undefined);
});

test('the settings handed out are copies, so a caller cannot change the schedule folders', () => {
    /* Given */
    const h = harness({file: JSON.stringify({scheduleDirs: ['~/projects/app']})});

    /* When */
    h.part.current().scheduleDirs?.push('~/projects/sneaky');

    /* Then */
    assert.deepEqual(h.part.current().scheduleDirs, ['~/projects/app']);
});

// ── Tool checks ──

test('the tool checks report versions, logins and sudo', async () => {
    /* Given */
    const h = harness({
        commands: {
            'claude --version': {stdout: '2.0.14 (Claude Code)\n'},
            'gh --version': {stdout: 'gh version 2.40.1 (2023-12-13)\nhttps://github.com/cli/cli/releases\n'},
            'gh auth status': {exitCode: 0},
            'git --version': {stdout: 'git version 2.43.0\n'},
            'sudo -n true': {exitCode: 0},
        },
        claude: {'.credentials.json': '{}'},
    });

    /* When */
    h.pair.mac.send({type: 'check-tools', requestId: 'r4'});
    await settle();

    /* Then */
    assert.deepEqual(h.received, [
        {
            type: 'tools',
            requestId: 'r4',
            tools: [
                {tool: 'claude', installed: true, version: '2.0.14', loggedIn: true},
                {tool: 'gh', installed: true, version: '2.40.1', loggedIn: true},
                {tool: 'git', installed: true, version: '2.43.0'},
            ],
            sudo: true,
        },
    ]);
});

test('missing tools, a gh with no login, no credentials and a sudo that asks all show as not ready', async () => {
    /* Given */
    const h = harness({
        commands: {
            'gh --version': {stdout: 'gh version 2.40.1'},
            'gh auth status': {exitCode: 1},
            'sudo -n true': {exitCode: 1},
        },
    });

    /* When */
    h.pair.mac.send({type: 'check-tools', requestId: 'r5'});
    await settle();

    /* Then */
    assert.deepEqual(h.received, [
        {
            type: 'tools',
            requestId: 'r5',
            tools: [
                {tool: 'claude', installed: false, loggedIn: false},
                {tool: 'gh', installed: true, version: '2.40.1', loggedIn: false},
                {tool: 'git', installed: false},
            ],
            sudo: false,
        },
    ]);
});

test('gh auth status is not run when gh is not installed', async () => {
    /* Given */
    const h = harness();

    /* When */
    h.pair.mac.send({type: 'check-tools', requestId: 'r6'});
    await settle();

    /* Then */
    assert.ok(!h.commands.ran.includes('gh auth status'));
});

test('a version is the first dotted number, or the first line without one', () => {
    /* Given */
    const outputs = ['2.0.14 (Claude Code)', 'git version 2.43.0', 'nightly build\nmore', ''];

    /* When */
    const versions = outputs.map(parseVersion);

    /* Then */
    assert.deepEqual(versions, ['2.0.14', '2.43.0', 'nightly build', undefined]);
});

// ── Config copy ──

test('the config copy writes safe files with their mode and removes stale ones', () => {
    /* Given */
    const h = harness({claude: {'commands/old.md': 'old'}});

    /* When */
    h.pair.mac.send({
        type: 'copy-config',
        requestId: 'r7',
        files: [file('CLAUDE.md', '# Me'), file('skills/x/run.sh', 'echo', 0o4755)],
        removed: ['commands/old.md'],
    });

    /* Then */
    assert.deepEqual(h.received, [{type: 'done', requestId: 'r7', ok: true}]);
    assert.deepEqual(h.claudeDir.files.get('CLAUDE.md'), {text: '# Me', mode: 0o644});
    assert.deepEqual(h.claudeDir.files.get('skills/x/run.sh'), {text: 'echo', mode: 0o755});
    assert.equal(h.claudeDir.files.has('commands/old.md'), false);
});

test("the plugin records' placeholder becomes this machine's ~/.claude, and other files are left as sent", () => {
    /* Given */
    const h = harness();
    const record = `{"installPath": "${CLAUDE_DIR_PLACEHOLDER}/plugins/cache/mkt/tool/1.0"}`;

    /* When */
    h.pair.mac.send({
        type: 'copy-config',
        requestId: 'r10',
        files: [file('plugins/installed_plugins.json', record), file('CLAUDE.md', CLAUDE_DIR_PLACEHOLDER)],
        removed: [],
    });

    /* Then */
    assert.equal(
        h.claudeDir.files.get('plugins/installed_plugins.json')?.text,
        '{"installPath": "/home/dev/.claude/plugins/cache/mkt/tool/1.0"}',
    );
    assert.equal(h.claudeDir.files.get('CLAUDE.md')?.text, CLAUDE_DIR_PLACEHOLDER);
});

test('unsafe paths are skipped, listed, and never touched', () => {
    /* Given */
    const h = harness({claude: {'.credentials.json': 'vm login'}});

    /* When */
    h.pair.mac.send({
        type: 'copy-config',
        requestId: 'r8',
        files: [file('../.ssh/authorized_keys', 'key'), file('.credentials.json', 'mac login'), file('ok.md', 'ok')],
        removed: ['/etc/passwd', '.credentials.json'],
    });

    /* Then */
    const done = h.received[0];
    assert.equal(done?.type, 'done');
    assert.equal(done.type === 'done' && done.ok, false);
    assert.match(done.type === 'done' ? (done.error ?? '') : '', /\.\.\/\.ssh\/authorized_keys.*\/etc\/passwd/);
    assert.equal(h.claudeDir.files.get('.credentials.json')?.text, 'vm login');
    assert.equal(h.claudeDir.files.get('ok.md')?.text, 'ok');
    assert.deepEqual([...h.claudeDir.files.keys()].sort(), ['.credentials.json', 'ok.md']);
});

test('a file that fails to write is reported and the rest are still written', () => {
    /* Given */
    const h = harness();
    const write = h.claudeDir.write;
    h.claudeDir.write = (p, content, mode) => {
        if (p === 'bad.md') throw new Error('disk full');
        write(p, content, mode);
    };

    /* When */
    h.pair.mac.send({
        type: 'copy-config',
        requestId: 'r9',
        files: [file('bad.md', 'x'), file('good.md', 'y')],
        removed: [],
    });

    /* Then */
    assert.deepEqual(h.received, [
        {type: 'done', requestId: 'r9', ok: false, error: 'Could not write: bad.md (disk full)'},
    ]);
    assert.equal(h.claudeDir.files.get('good.md')?.text, 'y');
});

// ── Node adapters ──

function tempDir(t: {after(fn: () => void): void}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agent-config-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return dir;
}

test('the config dir adapter writes atomically with the mode, removes, and refuses to leave its root', (t) => {
    /* Given */
    const root = path.join(tempDir(t), '.claude');
    const dir = new NodeClaudeConfigDir(root);

    /* When */
    dir.write('skills/x/run.sh', Buffer.from('echo hi'), 0o700);
    dir.write('skills/x/run.sh', Buffer.from('echo again'), 0o700);
    dir.write('CLAUDE.md', Buffer.from('# Me'), 0o644);
    dir.remove('CLAUDE.md');
    dir.remove('never-there.md');

    /* Then */
    const script = path.join(root, 'skills/x/run.sh');
    assert.equal(fs.readFileSync(script, 'utf8'), 'echo again');
    assert.equal(fs.statSync(script).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.join(root, 'skills/x')), ['run.sh']);
    assert.equal(dir.exists('CLAUDE.md'), false);
    assert.equal(dir.exists('skills/x/run.sh'), true);
    assert.throws(() => dir.write('../escape.md', Buffer.from('x'), 0o644), /outside/);
    assert.equal(fs.existsSync(path.join(root, '../escape.md')), false);
});

test('the settings file adapter round-trips, privately, and reads a missing file as null', (t) => {
    /* Given */
    const target = path.join(tempDir(t), 'nested', 'host-settings.json');
    const settingsFile = new NodeHostSettingsFile(target);
    const before = settingsFile.read();

    /* When */
    settingsFile.write('{"copyConfig":false}');

    /* Then */
    assert.equal(before, null);
    assert.equal(settingsFile.read(), '{"copyConfig":false}');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('the command runner reports exit codes, and null for a missing binary or a timeout', async () => {
    /* Given */
    const runner = new NodeCommandRunner();

    /* When */
    const ok = await runner.run(process.execPath, ['--version'], {timeoutMs: 5000});
    const failed = await runner.run(process.execPath, ['-e', 'process.exit(3)'], {timeoutMs: 5000});
    const missing = await runner.run('switchboard-no-such-tool', ['--version'], {timeoutMs: 5000});
    const hung = await runner.run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {timeoutMs: 100});

    /* Then */
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.stdout.trim(), process.version);
    assert.equal(failed.exitCode, 3);
    assert.equal(missing.exitCode, null);
    assert.equal(hung.exitCode, null);
});

test('layout paths expand $HOME and ~ on the VM', () => {
    /* Given */
    const home = '/home/me';

    /* When */
    const expanded = ['$HOME/.switchboard/host-settings.json', '~/projects', '/abs', '$HOME'].map((p) =>
        expandHome(p, home),
    );

    /* Then */
    assert.deepEqual(expanded, ['/home/me/.switchboard/host-settings.json', '/home/me/projects', '/abs', '/home/me']);
});
