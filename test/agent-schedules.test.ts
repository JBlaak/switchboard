import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {CommandRunner} from '../src/application/ports/claude-cli';
import {hostScheduleService} from '../src/application/services/agent-host/host-schedules';
import {ScheduleService} from '../src/application/services/schedule-service';
import type {HostSettings} from '../src/domain/agent/protocol';
import {homeForm, isUnderAny, isValidScheduleDir} from '../src/domain/agent/schedule-dirs';
import {encodeProjectPath} from '../src/domain/project/project-path';
import type {FolderMeta} from '../src/domain/session/session';
import {NodeScheduleRunner, withHostInstructionsArgs} from '../src/infrastructure/agent/node-schedule-runner';
import {NodeFileSystem} from '../src/infrastructure/fs/node-file-system';
import {FileTranscriptStore} from '../src/infrastructure/fs/transcript-store';
import {fakeTimers, silentLog, type FakeTimers} from './support/fakes';

/**
 * Schedules on a VM (#276 stage 5): the schedule service scoped to the host's
 * schedule folders, and the runner that starts headless `claude` there. Real
 * project and transcript folders in a temp home; the cron loop on fake timers
 * and a fixed clock; the runner against a fake `claude` that records how it
 * was started.
 */

const NOW = Date.UTC(2026, 10, 3, 9, 0, 0);

/** A temp home with `~/.claude/projects`. */
function world() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedules-')));
    const projects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(projects, {recursive: true});
    return {home, projects, transcripts: new FileTranscriptStore(new NodeFileSystem(), projects)};
}

/** A project with one schedule that runs every minute; its absolute path. */
function project(home: string, relative: string, slug = 'nightly'): string {
    const dir = path.join(home, relative);
    const commands = path.join(dir, '.claude', 'commands');
    fs.mkdirSync(commands, {recursive: true});
    fs.writeFileSync(
        path.join(commands, `schedule-${slug}.md`),
        `---\nname: ${slug} in ${relative}\ncron: * * * * *\n---\nTidy up.\n`,
    );
    return dir;
}

/** A transcript folder for a session that ran in `cwd`; the folder's name. */
function transcriptFor(projects: string, cwd: string, folder = encodeProjectPath(cwd)): string {
    fs.mkdirSync(path.join(projects, folder), {recursive: true});
    fs.writeFileSync(path.join(projects, folder, 'old.jsonl'), JSON.stringify({type: 'user', cwd}) + '\n');
    return folder;
}

/** A runner that records each run and finishes it at once. */
function recordingRunner(): CommandRunner & {runs: {args: readonly string[]; cwd: string; name: string}[]} {
    const runs: {args: readonly string[]; cwd: string; name: string}[] = [];
    return {
        runs,
        run(args, cwd, name, onDone) {
            runs.push({args, cwd, name});
            onDone();
        },
    };
}

function settingsWith(scheduleDirs: string[] | undefined): () => HostSettings {
    return () => ({instructions: 'On a VM.', copyConfig: true, baseFolder: '~/projects', scheduleDirs});
}

let ids = 0;
const nextId = {newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`};

function agentService(w: ReturnType<typeof world>, dirs: string[] | undefined, timers: FakeTimers = fakeTimers()) {
    const runner = recordingRunner();
    const service = hostScheduleService({
        fs: new NodeFileSystem(),
        transcripts: w.transcripts,
        runner,
        hostSettings: settingsWith(dirs),
        home: w.home,
        ids: nextId,
        clock: {now: () => NOW},
        timers,
        log: silentLog,
        commandsDir: path.join(w.home, '.claude', 'commands'),
    });
    return {service, runner, timers};
}

// ── The folders ──

test('a schedule folder holds itself and what is below it, not a sibling of a longer name', () => {
    /* Given */
    const home = '/home/dev';

    /* When */
    const verdicts = [
        '/home/dev/projects/app',
        '/home/dev/projects/app/.claude/worktrees/fix',
        '/home/dev/projects/app-two',
        '/home/dev/projects',
    ].map((p) => isUnderAny(p, ['~/projects/app/'], home));

    /* Then */
    assert.deepEqual(verdicts, [true, true, false, false]);
});

test('a schedule folder must be ~/… or absolute, without ..', () => {
    /* When */
    const verdicts = ['~/projects/app', '/srv/api', 'projects/app', '~', '/', '~/a/../b', '', '~/a\0'].map(
        isValidScheduleDir,
    );

    /* Then */
    assert.deepEqual(verdicts, [true, true, false, false, false, false, false, false]);
});

test('a path in home is written in ~ form, one outside it as it is', () => {
    /* When */
    const forms = ['/home/dev/projects/app', '/home/dev', '/home/devx/app', '/srv/api'].map((p) =>
        homeForm(p, '/home/dev'),
    );

    /* Then */
    assert.deepEqual(forms, ['~/projects/app', '~', '/home/devx/app', '/srv/api']);
});

// ── The agent's scan ──

test('only the projects in the schedule folders are scanned, a copy with no transcript yet included', () => {
    /* Given */
    const w = world();
    const app = project(w.home, 'projects/app');
    const fresh = project(w.home, 'projects/fresh');
    const elsewhere = project(w.home, 'projects/elsewhere');
    transcriptFor(w.projects, app);
    transcriptFor(w.projects, elsewhere);
    const {service} = agentService(w, ['~/projects/app', '~/projects/fresh']);

    /* When */
    const schedules = service.scan();

    /* Then */
    assert.deepEqual(
        schedules.map((s) => [s.projectPath, s.folder]),
        [
            [app, encodeProjectPath(app)],
            [fresh, encodeProjectPath(fresh)],
        ],
    );
});

test('a project with a worktree transcript folder too is scanned once, under its own folder', () => {
    /* Given */
    const w = world();
    const app = project(w.home, 'projects/app');
    fs.mkdirSync(path.join(app, '.claude', 'worktrees', 'fix'), {recursive: true});
    transcriptFor(w.projects, path.join(app, '.claude', 'worktrees', 'fix'));
    transcriptFor(w.projects, app);
    const {service} = agentService(w, ['~/projects/app']);

    /* When */
    const schedules = service.scan();

    /* Then */
    assert.deepEqual(
        schedules.map((s) => [s.projectPath, s.folder]),
        [[app, encodeProjectPath(app)]],
    );
});

test('a host with no schedule folders runs no schedules', () => {
    /* Given */
    const w = world();
    transcriptFor(w.projects, project(w.home, 'projects/app'));
    const {service} = agentService(w, undefined);

    /* When */
    const schedules = service.scan();

    /* Then */
    assert.deepEqual(schedules, []);
});

test('the cron loop runs only the schedules in the folders, seeding each run where claude resumes it', () => {
    /* Given */
    const w = world();
    const app = project(w.home, 'projects/app');
    const fresh = project(w.home, 'projects/fresh');
    transcriptFor(w.projects, app);
    transcriptFor(w.projects, project(w.home, 'projects/elsewhere'));
    const {service, runner, timers} = agentService(w, ['~/projects/app', '~/projects/fresh']);
    const stop = service.start();

    /* When */
    timers.tick();

    /* Then */
    stop();
    assert.deepEqual(
        runner.runs.map((run) => run.cwd),
        [app, fresh],
    );
    for (const run of runner.runs) {
        const sessionId = run.args[run.args.indexOf('--resume') + 1] ?? '';
        const seed = path.join(w.projects, encodeProjectPath(run.cwd), `${sessionId}.jsonl`);
        assert.equal(JSON.parse(fs.readFileSync(seed, 'utf8')).cwd, run.cwd);
    }
});

test('a schedule folder added later is scanned on the next tick', () => {
    /* Given */
    const w = world();
    const app = project(w.home, 'projects/app');
    let dirs: string[] = [];
    const runner = recordingRunner();
    const timers = fakeTimers();
    const service = hostScheduleService({
        fs: new NodeFileSystem(),
        transcripts: w.transcripts,
        runner,
        hostSettings: () => ({instructions: '', copyConfig: true, baseFolder: '~/projects', scheduleDirs: dirs}),
        home: w.home,
        ids: nextId,
        clock: {now: () => NOW},
        timers,
        log: silentLog,
        commandsDir: path.join(w.home, '.claude', 'commands'),
    });
    const stop = service.start();
    timers.tick();

    /* When */
    dirs = ['~/projects/app'];
    timers.tick();

    /* Then */
    stop();
    assert.deepEqual(
        runner.runs.map((run) => run.cwd),
        [app],
    );
});

// ── The Mac's instance, without the stage 5 deps ──

test('without the new deps the Mac scans every transcript folder as before, and nothing else', () => {
    /* Given */
    const w = world();
    const app = project(w.home, 'projects/app');
    const other = project(w.home, 'projects/other');
    project(w.home, 'projects/no-transcript');
    fs.mkdirSync(path.join(app, '.claude', 'worktrees', 'fix'), {recursive: true});
    const worktreeFolder = transcriptFor(w.projects, path.join(app, '.claude', 'worktrees', 'fix'));
    const appFolder = transcriptFor(w.projects, app);
    // The index knows `other` under a folder whose own transcripts say nothing.
    fs.mkdirSync(path.join(w.projects, 'indexed-folder'));
    const meta = new Map<string, FolderMeta>([
        ['indexed-folder', {folder: 'indexed-folder', projectPath: other, indexMtimeMs: 0}],
    ]);
    const service = new ScheduleService({
        fs: new NodeFileSystem(),
        transcripts: w.transcripts,
        repository: {getAllFolderMeta: () => meta},
        runner: recordingRunner(),
        ids: nextId,
        clock: {now: () => NOW},
        timers: fakeTimers(),
        log: silentLog,
        commandsDir: path.join(w.home, '.claude', 'commands'),
    });

    /* When */
    const schedules = service.scan();

    /* Then */
    assert.deepEqual(
        schedules.map((s) => [s.projectPath, s.folder]).sort(),
        [
            [app, appFolder],
            [app, worktreeFolder],
            [other, 'indexed-folder'],
        ].sort(),
    );
});

test('with only runsHere the Mac keeps one target per folder and filters them', () => {
    /* Given */
    const w = world();
    const app = project(w.home, 'projects/app');
    const paused = project(w.home, 'projects/paused');
    transcriptFor(w.projects, app);
    transcriptFor(w.projects, paused);
    const service = new ScheduleService({
        fs: new NodeFileSystem(),
        transcripts: w.transcripts,
        repository: {getAllFolderMeta: () => new Map()},
        runner: recordingRunner(),
        ids: nextId,
        clock: {now: () => NOW},
        timers: fakeTimers(),
        log: silentLog,
        commandsDir: path.join(w.home, '.claude', 'commands'),
        runsHere: (projectPath) => projectPath !== paused,
    });

    /* When */
    const schedules = service.scan();

    /* Then */
    assert.deepEqual(
        schedules.map((s) => s.projectPath),
        [app],
    );
});

// ── The runner ──

test('the host instructions follow a schedule’s own appended prompt, or are added alone', () => {
    /* Given */
    const own = ['--resume', 'id', '-p', 'Run', '--append-system-prompt', 'Be brief.', '--allowedTools', 'Read'];
    const none = ['--resume', 'id', '-p', 'Run'];

    /* When */
    const merged = withHostInstructionsArgs(own, 'On a VM.');
    const added = withHostInstructionsArgs(none, 'On a VM.');
    const unchanged = withHostInstructionsArgs(none, '  ');

    /* Then */
    assert.deepEqual(merged, [
        '--resume',
        'id',
        '-p',
        'Run',
        '--append-system-prompt',
        'Be brief.\n\nOn a VM.',
        '--allowedTools',
        'Read',
    ]);
    assert.deepEqual(added, ['--resume', 'id', '-p', 'Run', '--append-system-prompt', 'On a VM.']);
    assert.deepEqual(unchanged, none);
});

test('the runner starts claude in the project with the schedule args, the host instructions and the login env', async () => {
    /* Given */
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedule-runner-')));
    const bin = path.join(root, 'bin');
    const cwd = path.join(root, 'project');
    const record = path.join(root, 'record.json');
    fs.mkdirSync(bin);
    fs.mkdirSync(cwd);
    fs.writeFileSync(
        path.join(bin, 'claude'),
        `#!${process.execPath}\n` +
            `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({` +
            `args: process.argv.slice(2), cwd: process.cwd(), color: process.env.FORCE_COLOR, marker: process.env.SB_MARKER}));\n` +
            `process.stdout.write('done\\n');\n`,
        {mode: 0o755},
    );
    const lines: string[] = [];
    const log = {...silentLog, info: (...parts: unknown[]) => void lines.push(parts.join(' '))};
    const runner = new NodeScheduleRunner({
        env: {PATH: `${bin}:/usr/bin:/bin`, SB_MARKER: 'login-shell', FORCE_COLOR: '3'},
        hostInstructions: () => 'On a VM.',
        log,
    });

    /* When */
    await new Promise<void>((resolve) =>
        runner.run(['--resume', 'sid', '-p', 'Run the scheduled task'], cwd, 'nightly', resolve),
    );

    /* Then */
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), {
        args: ['--resume', 'sid', '-p', 'Run the scheduled task', '--append-system-prompt', 'On a VM.'],
        cwd,
        color: '0',
        marker: 'login-shell',
    });
    assert.ok(lines.some((line) => line.includes('nightly output:\ndone')));
    assert.ok(lines.some((line) => line.includes('nightly finished (exit 0)')));
});

test('a runner whose claude is missing still finishes the run', async () => {
    /* Given */
    const runner = new NodeScheduleRunner({
        env: {PATH: '/nonexistent'},
        hostInstructions: () => '',
        log: silentLog,
    });

    /* When */
    const finished = await new Promise<boolean>((resolve) =>
        runner.run(['-p', 'x'], os.tmpdir(), 'n', () => resolve(true)),
    );

    /* Then */
    assert.equal(finished, true);
});
