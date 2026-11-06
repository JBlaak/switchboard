import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectEditor, editorFallbacks, type FolderListing} from '../src/domain/workspace/editor';
import {NO_FOLDER, NO_SESSION, NOT_AVAILABLE_REMOTE} from '../src/domain/workspace/model';
import {WorkspaceActionService, type WorkspaceActionDeps} from '../src/application/services/workspace-action-service';
import type {WorkspaceLauncher} from '../src/application/ports/workspace-launcher';
import type {TranscriptLocation} from '../src/application/ports/transcript-store';
import {silentLog} from './support/fakes';

function listing(topLevel: string[], extra: Partial<FolderListing> = {}): FolderListing {
    return {topLevel, androidManifest: false, gradleFiles: {}, ...extra};
}

// ── Detection ──

test('a Gradle build with an Android manifest opens in Android Studio', () => {
    /* Given */
    const folder = listing(['build.gradle.kts', 'settings.gradle.kts', 'app'], {androidManifest: true});

    /* When */
    const editor = detectEditor(folder);

    /* Then */
    assert.equal(editor, 'android-studio');
});

test('a Gradle build naming the Android plugin opens in Android Studio', () => {
    /* Given */
    const byId = listing(['build.gradle'], {gradleFiles: {'build.gradle': "apply plugin: 'com.android.application'"}});
    const byCatalog = listing(['build.gradle.kts'], {
        gradleFiles: {'build.gradle.kts': 'plugins { alias(libs.plugins.android.application) apply false }'},
    });

    /* When */
    const editors = [detectEditor(byId), detectEditor(byCatalog)];

    /* Then */
    assert.deepEqual(editors, ['android-studio', 'android-studio']);
});

test('a Gradle build without Android is not an Android project', () => {
    /* Given */
    const folder = listing(['build.gradle.kts', 'src'], {
        gradleFiles: {'build.gradle.kts': 'plugins { kotlin("jvm") }'},
    });

    /* When */
    const editor = detectEditor(folder);

    /* Then */
    assert.equal(editor, 'sublime-text');
});

test('an Android manifest without a Gradle build is not an Android project', () => {
    /* Given */
    const folder = listing(['README.md'], {androidManifest: true});

    /* When */
    const editor = detectEditor(folder);

    /* Then */
    assert.equal(editor, 'sublime-text');
});

test('composer.json or package.json opens in PhpStorm', () => {
    /* Given */
    const php = listing(['composer.json', 'src']);
    const node = listing(['package.json', 'tsconfig.json']);

    /* When */
    const editors = [detectEditor(php), detectEditor(node)];

    /* Then */
    assert.deepEqual(editors, ['phpstorm', 'phpstorm']);
});

test('each Python marker opens in PyCharm', () => {
    /* Given */
    const folders = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].map((name) => listing([name]));

    /* When */
    const editors = folders.map(detectEditor);

    /* Then */
    assert.deepEqual(editors, ['pycharm', 'pycharm', 'pycharm', 'pycharm']);
});

test('anything else opens in Sublime Text', () => {
    /* Given */
    const folder = listing(['README.md', 'notes.txt']);

    /* When */
    const editor = detectEditor(folder);

    /* Then */
    assert.equal(editor, 'sublime-text');
});

test('Android wins over PHP/Node, and PHP/Node over Python', () => {
    /* Given */
    const androidWithNode = listing(['build.gradle', 'package.json', 'requirements.txt'], {androidManifest: true});
    const nodeWithPython = listing(['package.json', 'pyproject.toml']);

    /* When */
    const editors = [detectEditor(androidWithNode), detectEditor(nodeWithPython)];

    /* Then */
    assert.deepEqual(editors, ['android-studio', 'phpstorm']);
});

test('an IDE falls back to Sublime Text, and Sublime Text has no editor after it', () => {
    /* When */
    const chains = [editorFallbacks('pycharm'), editorFallbacks('sublime-text')];

    /* Then */
    assert.deepEqual(chains, [['pycharm', 'sublime-text'], ['sublime-text']]);
});

// ── The service, with a fake launcher ──

const REPO = '/code/shop';
const WORKTREE = '/code/shop/.claude/worktrees/42-cart';

/** An in-memory folder tree: each directory's entries, and the files' text. */
interface FakeDisk {
    dirs: Record<string, string[]>;
    files?: Record<string, string>;
}

function fakeFs(disk: FakeDisk): WorkspaceActionDeps['fs'] {
    const files = disk.files ?? {};
    return {
        exists: (path) => path in disk.dirs || path in files,
        isDirectory: (path) => path in disk.dirs,
        readDir: (path) => (disk.dirs[path] ?? []).map((name) => ({name, isFile: true, isDirectory: false})),
        readText: (path) => {
            if (!(path in files)) throw new Error('ENOENT ' + path);
            return files[path];
        },
        join: (...parts) => parts.join('/'),
    };
}

interface FakeLauncher extends WorkspaceLauncher {
    /** Every attempt, as `<app> <directory>`, Finder included. */
    readonly attempts: string[];
}

/** A launcher with only `installed` apps; Finder always opens. */
function fakeLauncher(installed: string[]): FakeLauncher {
    const attempts: string[] = [];
    return {
        attempts,
        openWith: async (app, directory) => {
            attempts.push(`${app} ${directory}`);
            return installed.includes(app);
        },
        showInFinder: async (directory) => {
            attempts.push(`Finder ${directory}`);
            return true;
        },
    };
}

interface ServiceSetup {
    disk?: FakeDisk;
    installed?: string[];
    sessions?: Record<string, {folder: string | null; projectPath: string}>;
    locations?: TranscriptLocation[];
}

function service(setup: ServiceSetup = {}): {service: WorkspaceActionService; launcher: FakeLauncher} {
    const launcher = fakeLauncher(setup.installed ?? []);
    const sessions = setup.sessions ?? {};
    return {
        launcher,
        service: new WorkspaceActionService({
            locate: (id) => sessions[id] ?? null,
            transcripts: {locations: () => setup.locations ?? []},
            fs: fakeFs(setup.disk ?? {dirs: {[REPO]: ['package.json']}}),
            launcher,
            log: silentLog,
        }),
    };
}

test('opening a PHP/Node repo uses PhpStorm when it is installed', async () => {
    /* Given */
    const {service: workspace, launcher} = service({installed: ['PhpStorm', 'Sublime Text']});

    /* When */
    const result = await workspace.openInEditor({directory: REPO});

    /* Then */
    assert.deepEqual(result, {ok: true, directory: REPO, openedWith: 'PhpStorm'});
    assert.deepEqual(launcher.attempts, [`PhpStorm ${REPO}`]);
});

test('a missing IDE falls back to Sublime Text', async () => {
    /* Given */
    const {service: workspace, launcher} = service({installed: ['Sublime Text']});

    /* When */
    const result = await workspace.openInEditor({directory: REPO});

    /* Then */
    assert.deepEqual(result, {ok: true, directory: REPO, openedWith: 'Sublime Text'});
    assert.deepEqual(launcher.attempts, [`PhpStorm ${REPO}`, `Sublime Text ${REPO}`]);
});

test('with neither the IDE nor Sublime Text, the folder opens in Finder', async () => {
    /* Given */
    const {service: workspace, launcher} = service({installed: []});

    /* When */
    const result = await workspace.openInEditor({directory: REPO});

    /* Then */
    assert.deepEqual(result, {ok: true, directory: REPO, openedWith: 'Finder'});
    assert.deepEqual(launcher.attempts, [`PhpStorm ${REPO}`, `Sublime Text ${REPO}`, `Finder ${REPO}`]);
});

test('an Android project is told apart by the manifest under app/', async () => {
    /* Given */
    const disk = {
        dirs: {[REPO]: ['build.gradle.kts', 'app']},
        files: {[`${REPO}/app/src/main/AndroidManifest.xml`]: '<manifest/>', [`${REPO}/build.gradle.kts`]: ''},
    };
    const {service: workspace} = service({disk});

    /* When */
    const info = await workspace.editorFor({directory: REPO});

    /* Then */
    assert.deepEqual(info, {available: true, directory: REPO, editor: 'android-studio', app: 'Android Studio'});
});

test('Shell here prefers iTerm', async () => {
    /* Given */
    const {service: workspace, launcher} = service({installed: ['iTerm', 'Terminal']});

    /* When */
    const result = await workspace.shellHere({directory: REPO});

    /* Then */
    assert.deepEqual(result, {ok: true, directory: REPO, openedWith: 'iTerm'});
    assert.deepEqual(launcher.attempts, [`iTerm ${REPO}`]);
});

test('Shell here opens Terminal when iTerm is not installed', async () => {
    /* Given */
    const {service: workspace, launcher} = service({installed: ['Terminal']});

    /* When */
    const result = await workspace.shellHere({directory: REPO});

    /* Then */
    assert.deepEqual(result, {ok: true, directory: REPO, openedWith: 'Terminal'});
    assert.deepEqual(launcher.attempts, [`iTerm ${REPO}`, `Terminal ${REPO}`]);
});

test('Finder opens the folder', async () => {
    /* Given */
    const {service: workspace, launcher} = service();

    /* When */
    const result = await workspace.revealInFinder({directory: REPO});

    /* Then */
    assert.deepEqual(result, {ok: true, directory: REPO, openedWith: 'Finder'});
    assert.deepEqual(launcher.attempts, [`Finder ${REPO}`]);
});

test("a session's actions use the worktree it last worked in", async () => {
    /* Given */
    const {service: workspace, launcher} = service({
        installed: ['iTerm'],
        disk: {dirs: {[REPO]: ['package.json'], [WORKTREE]: ['package.json']}},
        sessions: {s1: {folder: '-code-shop', projectPath: REPO}},
        locations: [
            {cwd: REPO, branch: 'main', fromSubagent: false},
            {cwd: WORKTREE, branch: '42-cart', fromSubagent: false},
            {cwd: '/code/elsewhere', branch: 'x', fromSubagent: true},
        ],
    });

    /* When */
    await workspace.shellHere({sessionId: 's1'});

    /* Then */
    assert.deepEqual(launcher.attempts, [`iTerm ${WORKTREE}`]);
});

test('a session whose worktree is gone uses the directory it started in', async () => {
    /* Given */
    const {service: workspace} = service({
        sessions: {s1: {folder: '-code-shop', projectPath: REPO}},
        locations: [{cwd: WORKTREE, branch: '42-cart', fromSubagent: false}],
    });

    /* When */
    const info = await workspace.editorFor({sessionId: 's1'});

    /* Then */
    assert.deepEqual(info, {available: true, directory: REPO, editor: 'phpstorm', app: 'PhpStorm'});
});

test('a remote session answers not available and launches nothing', async () => {
    /* Given */
    const {service: workspace, launcher} = service({
        installed: ['iTerm'],
        sessions: {r1: {folder: null, projectPath: 'ssh://joris@box:22/srv/app'}},
    });

    /* When */
    const results = [
        await workspace.editorFor({sessionId: 'r1'}),
        await workspace.openInEditor({sessionId: 'r1'}),
        await workspace.revealInFinder({sessionId: 'r1'}),
        await workspace.shellHere({sessionId: 'r1'}),
    ];

    /* Then */
    assert.deepEqual(results, [
        {available: false, reason: NOT_AVAILABLE_REMOTE},
        {ok: false, reason: NOT_AVAILABLE_REMOTE},
        {ok: false, reason: NOT_AVAILABLE_REMOTE},
        {ok: false, reason: NOT_AVAILABLE_REMOTE},
    ]);
    assert.deepEqual(launcher.attempts, []);
});

test('an unknown session, or a path that is not a directory, launches nothing', async () => {
    /* Given */
    const {service: workspace, launcher} = service({
        installed: ['iTerm'],
        disk: {dirs: {[REPO]: ['run.sh']}, files: {[`${REPO}/run.sh`]: 'rm -rf ~'}},
    });

    /* When */
    const results = [
        await workspace.shellHere({sessionId: 'nobody'}),
        await workspace.shellHere({directory: `${REPO}/run.sh`}),
        await workspace.shellHere({directory: 'relative/path'}),
    ];

    /* Then */
    assert.deepEqual(results, [
        {ok: false, reason: NO_SESSION},
        {ok: false, reason: NO_FOLDER},
        {ok: false, reason: NO_FOLDER},
    ]);
    assert.deepEqual(launcher.attempts, []);
});
