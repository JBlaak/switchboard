import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    CLAUDE_DIR_PLACEHOLDER,
    CONFIG_COPY_RULES_VERSION,
    CONFIG_FILE_CAP_BYTES,
    type ConfigEntry,
    expandClaudeDirPlaceholder,
    isUnchanged,
    planPlugins,
    planSettings,
    removedSince,
    selectConfigFiles,
} from '../src/domain/agent/config-copy';
import type {HostSettings} from '../src/domain/agent/protocol';
import type {ClaudeConfigSource, ConfigCopyReply, ConfigManifestStore} from '../src/application/ports/claude-config';
import {
    CONFIG_MANIFESTS_SETTINGS_KEY,
    ConfigCopyService,
    manifestStoreOn,
} from '../src/application/services/config-copy-service';
import type {ConfigFile} from '../src/domain/agent/protocol';
import type {ConfigCopyManifest} from '../src/domain/agent/config-copy';
import {silentLog} from './support/fakes';

/**
 * The global config copy, Mac side: which files of `~/.claude` go to a VM, how
 * plugin records and `settings.json` are rewritten for it, and when the
 * service sends, skips or remembers a copy.
 */

const HOME = '/Users/me';
const CLAUDE = `${HOME}/.claude`;

function entry(path: string, size = 10, mtimeMs = 1): ConfigEntry {
    return {path, size, mode: 0o100644, mtimeMs};
}

// ── In-memory fakes ──

interface FakeFile {
    content: string;
    mtimeMs?: number;
    mode?: number;
}

function fakeSource(files: Record<string, FakeFile | string>) {
    const tree = new Map<string, FakeFile>(
        Object.entries(files).map(([path, file]) => [path, typeof file === 'string' ? {content: file} : file]),
    );
    const unreadable = new Set<string>();
    const toEntry = (path: string, file: FakeFile): ConfigEntry => ({
        path,
        size: new TextEncoder().encode(file.content).length,
        mode: file.mode ?? 0o100644,
        mtimeMs: file.mtimeMs ?? 1,
    });
    const source: ClaudeConfigSource = {
        homeDir: HOME,
        list: (folder) =>
            [...tree].filter(([path]) => path.startsWith(folder + '/')).map(([path, file]) => toEntry(path, file)),
        stat: (path) => {
            const file = tree.get(path);
            return file ? toEntry(path, file) : null;
        },
        read: (path) => {
            const file = tree.get(path);
            if (!file || unreadable.has(path)) throw new Error(`ENOENT: ${path}`);
            return new TextEncoder().encode(file.content);
        },
    };
    return {
        source,
        write(path: string, content: string, mtimeMs = 2) {
            tree.set(path, {content, mtimeMs});
        },
        remove(path: string) {
            tree.delete(path);
        },
        breakRead(path: string) {
            unreadable.add(path);
        },
    };
}

function fakeManifests(): ConfigManifestStore & {saved: Map<string, ConfigCopyManifest>} {
    const saved = new Map<string, ConfigCopyManifest>();
    return {saved, get: (key) => saved.get(key) ?? null, set: (key, manifest) => void saved.set(key, manifest)};
}

function fakeConnection(reply: ConfigCopyReply = {ok: true}) {
    const sent: {files: ConfigFile[]; removed: string[]}[] = [];
    return {
        sent,
        reply,
        copyConfig: async (request: {files: ConfigFile[]; removed: string[]}) => {
            sent.push(request);
            return reply;
        },
    };
}

const HOST = {user: 'me', host: 'vm.local', port: 22};
const ON: HostSettings = {instructions: '', copyConfig: true, baseFolder: '~/projects'};
const OFF: HostSettings = {...ON, copyConfig: false};

function service(files: Record<string, FakeFile | string>) {
    const fs = fakeSource(files);
    const manifests = fakeManifests();
    return {fs, manifests, service: new ConfigCopyService({source: fs.source, manifests, logger: silentLog})};
}

const decode = (file: ConfigFile) => Buffer.from(file.contentBase64, 'base64').toString('utf8');
const paths = (files: ConfigFile[]) => files.map((file) => file.path).sort();

// A real-shaped plugin layout, as Claude Code writes it.
const INSTALLED = JSON.stringify({
    version: 2,
    plugins: {
        'tidy@acme': [
            {scope: 'user', installPath: `${CLAUDE}/plugins/cache/acme/tidy/1.0.0`, version: '1.0.0'},
            {scope: 'project', projectPath: `${HOME}/code/app`, installPath: `${CLAUDE}/plugins/cache/acme/tidy/0.9.0`},
        ],
        'local-only@acme': [
            {
                scope: 'project',
                projectPath: `${HOME}/code/app`,
                installPath: `${CLAUDE}/plugins/cache/acme/local-only/1.0.0`,
            },
        ],
    },
});
const MARKETPLACES = JSON.stringify({
    acme: {
        source: {source: 'github', repo: 'acme/plugins'},
        installLocation: `${CLAUDE}/plugins/marketplaces/acme`,
        autoUpdate: true,
    },
    unused: {source: {source: 'github', repo: 'x/y'}, installLocation: `${CLAUDE}/plugins/marketplaces/unused`},
});

// ── Selection ──

test('CLAUDE.md, skills, commands and agents are chosen; the rest of ~/.claude is not', () => {
    /* Given */
    const entries = [
        'CLAUDE.md',
        'skills/tdd/SKILL.md',
        'commands/release.md',
        'agents/reviewer.md',
        'history.jsonl',
        'projects/-Users-me-app/abc.jsonl',
        'hooks/peon.sh',
        'plugins/data/x/state.json',
    ].map((path) => entry(path));

    /* When */
    const {selected} = selectConfigFiles(entries, []);

    /* Then */
    assert.deepEqual(
        selected.map((file) => file.path),
        ['CLAUDE.md', 'agents/reviewer.md', 'commands/release.md', 'skills/tdd/SKILL.md'],
    );
});

test('a plugin folder is chosen along with the copied folders', () => {
    /* Given */
    const entries = [entry('plugins/cache/acme/tidy/1.0.0/skills/a.md'), entry('plugins/cache/acme/tidy/0.9.0/a.md')];

    /* When */
    const {selected} = selectConfigFiles(entries, ['plugins/cache/acme/tidy/1.0.0']);

    /* Then */
    assert.deepEqual(
        selected.map((file) => file.path),
        ['plugins/cache/acme/tidy/1.0.0/skills/a.md'],
    );
});

test('.git, node_modules, .DS_Store, .in_use and .trash are never chosen', () => {
    /* Given */
    const entries = [
        'skills/a/.git/HEAD',
        'skills/a/node_modules/x/index.js',
        'skills/.DS_Store',
        'skills/.trash/old/SKILL.md',
        'plugins/cache/acme/tidy/1.0.0/.in_use/4242',
        'skills/a/SKILL.md',
    ].map((path) => entry(path));

    /* When */
    const {selected, skipped} = selectConfigFiles(entries, ['plugins/cache/acme/tidy/1.0.0']);

    /* Then */
    assert.deepEqual(
        selected.map((file) => file.path),
        ['skills/a/SKILL.md'],
    );
    assert.deepEqual(skipped, []);
});

test('a file over the size cap is skipped with a reason', () => {
    /* Given */
    const entries = [entry('skills/a/big.bin', CONFIG_FILE_CAP_BYTES + 1), entry('skills/a/SKILL.md')];

    /* When */
    const {selected, skipped} = selectConfigFiles(entries, []);

    /* Then */
    assert.deepEqual(
        selected.map((file) => file.path),
        ['skills/a/SKILL.md'],
    );
    assert.deepEqual(
        skipped.map((file) => file.path),
        ['skills/a/big.bin'],
    );
});

test('a path isSafeConfigPath refuses is skipped with a reason', () => {
    /* Given */
    const entries = [entry('skills/../projects/x.jsonl'), entry('skills/a//b.md')];

    /* When */
    const {selected, skipped} = selectConfigFiles(entries, []);

    /* Then */
    assert.deepEqual(selected, []);
    assert.deepEqual(
        skipped.map((file) => file.reason),
        ['refused by isSafeConfigPath', 'refused by isSafeConfigPath'],
    );
});

// ── removed ──

test('removed lists what the last copy wrote that this one does not', () => {
    /* Given */
    const previous = {rules: CONFIG_COPY_RULES_VERSION, files: {'CLAUDE.md': '1:1', 'skills/old/SKILL.md': '1:1'}};
    const next = {rules: CONFIG_COPY_RULES_VERSION, files: {'CLAUDE.md': '1:1'}};

    /* When */
    const removed = removedSince(previous, next);

    /* Then */
    assert.deepEqual(removed, ['skills/old/SKILL.md']);
});

test('removed never names an unsafe path, even from a stored manifest', () => {
    /* Given */
    const previous = {
        rules: CONFIG_COPY_RULES_VERSION,
        files: {'../.ssh/authorized_keys': '1:1', '.credentials.json': '1:1'},
    };

    /* When */
    const removed = removedSince(previous, {rules: CONFIG_COPY_RULES_VERSION, files: {}});

    /* Then */
    assert.deepEqual(removed, []);
});

test('the first copy to a host removes nothing', () => {
    /* When */
    const removed = removedSince(null, {rules: CONFIG_COPY_RULES_VERSION, files: {}});

    /* Then */
    assert.deepEqual(removed, []);
});

test('a manifest from older rules is never unchanged', () => {
    /* Given */
    const files = {'CLAUDE.md': '1:1'};

    /* When */
    const unchanged = isUnchanged(
        {rules: CONFIG_COPY_RULES_VERSION - 1, files},
        {rules: CONFIG_COPY_RULES_VERSION, files},
    );

    /* Then */
    assert.equal(unchanged, false);
});

// ── Plugins and the path rule ──

function pluginPlan(installed = INSTALLED, marketplaces: string | null = MARKETPLACES) {
    return planPlugins({
        installedPluginsJson: installed,
        knownMarketplacesJson: marketplaces,
        macHome: HOME,
        hasFiles: (folder) => folder === 'plugins/cache/acme/tidy/1.0.0',
    });
}

test('a user-scope plugin is copied with its install folder and its marketplace manifest', () => {
    /* When */
    const plan = pluginPlan();

    /* Then */
    assert.deepEqual(plan.plugins, ['tidy@acme']);
    assert.deepEqual(plan.folders, ['plugins/cache/acme/tidy/1.0.0', 'plugins/marketplaces/acme/.claude-plugin']);
});

test('a plugin installed for Mac projects only is left out with a reason', () => {
    /* When */
    const plan = pluginPlan();

    /* Then */
    assert.deepEqual(plan.dropped, [{plugin: 'local-only@acme', reason: 'installed for Mac projects only'}]);
});

test('the plugin records name the VM through the placeholder, never the Mac', () => {
    /* When */
    const plan = pluginPlan();

    /* Then */
    const installed = JSON.parse(plan.installedPlugins ?? '');
    const marketplaces = JSON.parse(plan.knownMarketplaces ?? '');
    assert.deepEqual(installed.plugins['tidy@acme'], [
        {scope: 'user', installPath: `${CLAUDE_DIR_PLACEHOLDER}/plugins/cache/acme/tidy/1.0.0`, version: '1.0.0'},
    ]);
    assert.deepEqual(Object.keys(marketplaces), ['acme']);
    assert.equal(marketplaces.acme.installLocation, `${CLAUDE_DIR_PLACEHOLDER}/plugins/marketplaces/acme`);
    assert.equal((plan.installedPlugins + (plan.knownMarketplaces ?? '')).includes(HOME), false);
});

test('the agent expands the placeholder to its own ~/.claude', () => {
    /* Given */
    const content = pluginPlan().installedPlugins ?? '';

    /* When */
    const expanded = expandClaudeDirPlaceholder(content, '/home/dev/.claude/');

    /* Then */
    assert.equal(
        JSON.parse(expanded).plugins['tidy@acme'][0].installPath,
        '/home/dev/.claude/plugins/cache/acme/tidy/1.0.0',
    );
});

test('a plugin installed outside ~/.claude is left out with a reason', () => {
    /* Given */
    const installed = JSON.stringify({version: 2, plugins: {'tidy@acme': [{scope: 'user', installPath: '/opt/tidy'}]}});

    /* When */
    const plan = pluginPlan(installed);

    /* Then */
    assert.deepEqual(plan.plugins, []);
    assert.deepEqual(plan.dropped, [{plugin: 'tidy@acme', reason: 'installed outside ~/.claude/plugins/cache'}]);
    assert.equal(plan.installedPlugins, null);
});

test('a plugin whose marketplace is not known is left out with a reason', () => {
    /* When */
    const plan = pluginPlan(INSTALLED, null);

    /* Then */
    assert.deepEqual(
        plan.dropped.map((dropped) => dropped.plugin),
        ['local-only@acme', 'tidy@acme'],
    );
    assert.equal(plan.knownMarketplaces, null);
});

test('a plugin whose marketplace comes from a Mac folder is left out with a reason', () => {
    /* Given */
    const marketplaces = JSON.stringify({
        acme: {
            source: {source: 'directory', path: `${HOME}/code/plugins`},
            installLocation: `${CLAUDE}/plugins/marketplaces/acme`,
        },
    });

    /* When */
    const plan = pluginPlan(INSTALLED, marketplaces);

    /* Then */
    assert.deepEqual(plan.plugins, []);
    assert.equal(
        plan.dropped.find((dropped) => dropped.plugin === 'tidy@acme')?.reason,
        'its records name other Mac paths',
    );
});

// ── settings.json ──

const MAC_SETTINGS = JSON.stringify({
    model: 'opus',
    effortLevel: 'xhigh',
    permissions: {
        defaultMode: 'auto',
        allow: ['Bash(npm test)', `Read(${HOME}/secrets/**)`],
        additionalDirectories: [`${HOME}/code`],
    },
    hooks: {Stop: [{matcher: '', hooks: [{type: 'command', command: `${CLAUDE}/hooks/peon.sh`}]}]},
    statusLine: {type: 'command', command: `bash ${CLAUDE}/statusline-command.sh`},
    env: {GITHUB_TOKEN: 'secret'},
    apiKeyHelper: '/usr/local/bin/key',
    enabledPlugins: {'tidy@acme': true, 'local-only@acme': true},
    extraKnownMarketplaces: {
        acme: {source: {source: 'github', repo: 'acme/plugins'}},
        mine: {source: {source: 'directory', path: `${HOME}/code/plugins`}},
    },
    enableAllProjectMcpServers: true,
});

test('settings.json keeps only the allowed keys, without hooks, secrets or Mac paths', () => {
    /* When */
    const plan = planSettings(MAC_SETTINGS, HOME, new Set(['tidy@acme']));

    /* Then */
    assert.deepEqual(JSON.parse(plan.content ?? ''), {
        model: 'opus',
        effortLevel: 'xhigh',
        permissions: {defaultMode: 'auto', allow: ['Bash(npm test)']},
        enabledPlugins: {'tidy@acme': true},
        extraKnownMarketplaces: {acme: {source: {source: 'github', repo: 'acme/plugins'}}},
    });
    assert.deepEqual(plan.dropped.sort(), ['apiKeyHelper', 'enableAllProjectMcpServers', 'env', 'hooks', 'statusLine']);
});

test('a settings.json with nothing worth copying is not sent', () => {
    /* Given */
    const json = JSON.stringify({hooks: {}, env: {A: 'b'}});

    /* When */
    const plan = planSettings(json, HOME, new Set());

    /* Then */
    assert.equal(plan.content, null);
});

test('a settings.json that is not JSON is not sent', () => {
    /* When */
    const plan = planSettings('{not json', HOME, new Set());

    /* Then */
    assert.equal(plan.content, null);
    assert.deepEqual(plan.dropped, ['settings.json']);
});

// ── The service ──

const MAC_CLAUDE = {
    'CLAUDE.md': '# Me',
    'skills/tdd/SKILL.md': 'tdd',
    'commands/release.md': 'release',
    'skills/tdd/.DS_Store': 'x',
    'history.jsonl': 'secret history',
    '.credentials.json': '{"token":"x"}',
    'settings.json': MAC_SETTINGS,
    'plugins/installed_plugins.json': INSTALLED,
    'plugins/known_marketplaces.json': MARKETPLACES,
    'plugins/cache/acme/tidy/1.0.0/skills/tidy/SKILL.md': 'tidy',
    'plugins/cache/acme/tidy/1.0.0/node_modules/x/index.js': 'x',
    'plugins/marketplaces/acme/.claude-plugin/marketplace.json': '{"name":"acme"}',
    'plugins/marketplaces/acme/plugins/other/README.md': 'other',
};

test('with copyConfig off nothing is read or sent', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);
    const connection = fakeConnection();

    /* When */
    const outcome = await h.service.copyTo(HOST, connection, OFF);

    /* Then */
    assert.deepEqual(outcome, {kind: 'off'});
    assert.equal(connection.sent.length, 0);
    assert.equal(h.manifests.saved.size, 0);
});

test('the first copy sends the config, its rewritten records and filtered settings, and nothing else', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);
    const connection = fakeConnection();

    /* When */
    await h.service.copyTo(HOST, connection, ON);

    /* Then */
    assert.equal(connection.sent.length, 1);
    assert.deepEqual(paths(connection.sent[0].files), [
        'CLAUDE.md',
        'commands/release.md',
        'plugins/cache/acme/tidy/1.0.0/skills/tidy/SKILL.md',
        'plugins/installed_plugins.json',
        'plugins/known_marketplaces.json',
        'plugins/marketplaces/acme/.claude-plugin/marketplace.json',
        'settings.json',
        'skills/tdd/SKILL.md',
    ]);
    assert.deepEqual(connection.sent[0].removed, []);
});

test('files go as base64 with their permission bits', async () => {
    /* Given */
    const h = service({...MAC_CLAUDE, 'skills/tdd/run.sh': {content: '#!/bin/sh', mode: 0o100755}});
    const connection = fakeConnection();

    /* When */
    await h.service.copyTo(HOST, connection, ON);

    /* Then */
    const script = connection.sent[0].files.find((file) => file.path === 'skills/tdd/run.sh');
    assert.equal(script && decode(script), '#!/bin/sh');
    assert.equal(script?.mode, 0o755);
});

test('a successful copy saves the manifest for the host', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);

    /* When */
    await h.service.copyTo(HOST, fakeConnection(), ON);

    /* Then */
    const manifest = h.manifests.saved.get('me@vm.local:22');
    assert.equal(manifest?.rules, CONFIG_COPY_RULES_VERSION);
    assert.equal(Object.keys(manifest?.files ?? {}).length, 8);
});

test('when nothing changed since the last copy nothing is sent', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);
    await h.service.copyTo(HOST, fakeConnection(), ON);
    const connection = fakeConnection();

    /* When */
    const outcome = await h.service.copyTo(HOST, connection, ON);

    /* Then */
    assert.deepEqual(outcome, {kind: 'unchanged'});
    assert.equal(connection.sent.length, 0);
});

test('an edited file makes the next connect send the copy again', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);
    await h.service.copyTo(HOST, fakeConnection(), ON);
    h.fs.write('CLAUDE.md', '# Me, edited');
    const connection = fakeConnection();

    /* When */
    await h.service.copyTo(HOST, connection, ON);

    /* Then */
    assert.equal(connection.sent.length, 1);
    const claudeMd = connection.sent[0].files.find((file) => file.path === 'CLAUDE.md');
    assert.equal(claudeMd && decode(claudeMd), '# Me, edited');
});

test('a file deleted on the Mac is removed on the VM', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);
    await h.service.copyTo(HOST, fakeConnection(), ON);
    h.fs.remove('commands/release.md');
    const connection = fakeConnection();

    /* When */
    await h.service.copyTo(HOST, connection, ON);

    /* Then */
    assert.deepEqual(connection.sent[0].removed, ['commands/release.md']);
});

test('a failed done does not save the manifest, so the next connect sends again', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);
    const failing = fakeConnection({ok: false, error: 'disk full'});

    /* When */
    const outcome = await h.service.copyTo(HOST, failing, ON);

    /* Then */
    assert.deepEqual(outcome, {kind: 'failed', error: 'disk full'});
    assert.equal(h.manifests.saved.size, 0);
});

test('a link that drops mid-copy is logged, not thrown', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);
    const connection = {copyConfig: async () => Promise.reject(new Error('link closed'))};

    /* When */
    const outcome = await h.service.copyTo(HOST, connection, ON);

    /* Then */
    assert.deepEqual(outcome, {kind: 'failed', error: 'link closed'});
    assert.equal(h.manifests.saved.size, 0);
});

test('a config over the message cap is not sent at all', async () => {
    /* Given */
    const big = 'x'.repeat(CONFIG_FILE_CAP_BYTES - 1);
    const files: Record<string, string> = {'CLAUDE.md': '# Me'};
    for (let i = 0; i < 14; i++) files[`skills/big/part-${i}.md`] = big;
    const h = service(files);
    const connection = fakeConnection();

    /* When */
    const outcome = await h.service.copyTo(HOST, connection, ON);

    /* Then */
    assert.equal(outcome.kind, 'too-large');
    assert.equal(connection.sent.length, 0);
    assert.equal(h.manifests.saved.size, 0);
});

test('a file that cannot be read is left out without removing the VM copy', async () => {
    /* Given */
    const h = service(MAC_CLAUDE);
    await h.service.copyTo(HOST, fakeConnection(), ON);
    h.fs.write('commands/release.md', 'release v2');
    h.fs.breakRead('commands/release.md');
    const connection = fakeConnection();

    /* When */
    await h.service.copyTo(HOST, connection, ON);

    /* Then */
    assert.equal(paths(connection.sent[0].files).includes('commands/release.md'), false);
    assert.deepEqual(connection.sent[0].removed, []);
});

test('the manifest store keeps each host under one settings key', () => {
    /* Given */
    const values = new Map<string, unknown>();
    const store = manifestStoreOn({
        get: <T>(key: string) => (values.get(key) as T) ?? null,
        set: (key, value) => void values.set(key, value),
        delete: (key) => void values.delete(key),
    });
    const manifest = {rules: CONFIG_COPY_RULES_VERSION, files: {'CLAUDE.md': '1:1'}};

    /* When */
    store.set('a@vm:22', manifest);
    store.set('b@vm:22', manifest);

    /* Then */
    assert.deepEqual(Object.keys(values.get(CONFIG_MANIFESTS_SETTINGS_KEY) as object), ['a@vm:22', 'b@vm:22']);
    assert.deepEqual(store.get('a@vm:22'), manifest);
});
