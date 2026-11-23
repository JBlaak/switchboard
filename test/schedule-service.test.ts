import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {CommandEnding, CommandRunner} from '../src/application/ports/claude-cli';
import type {TimerHandle, Timers} from '../src/application/ports/clock';
import type {GitWrite} from '../src/application/ports/git-workspace';
import {KILL_GRACE_MS, ScheduleService} from '../src/application/services/schedule-service';
import {SCHEDULE_CREATOR_TEMPLATE} from '../src/domain/schedule/creator-template';
import type {ScheduleServiceDeps} from '../src/application/services/schedule-service';
import {MemoryScheduleRunStore} from '../src/application/services/support/memory-schedule-runs';
import {encodeProjectPath} from '../src/domain/project/project-path';
import type {Usage} from '../src/domain/usage/usage';
import {NodeFileSystem} from '../src/infrastructure/fs/node-file-system';
import {FileTranscriptStore} from '../src/infrastructure/fs/transcript-store';
import {silentLog} from './support/fakes';

/**
 * The scheduler as the Schedule manager's engine: which schedules it lists and
 * runs, what it records of each run, the week cap, Skip, the time limit, the
 * run's own worktree, missed times and runs a quit left behind. Real project
 * and transcript folders in a temp home; the runner, the usage endpoint, git,
 * the clock and the timers are fakes.
 */

/** 03:00 local on a Tuesday. */
const THREE_AM = new Date(2026, 10, 3, 3, 0, 0).getTime();
const MINUTE = 60_000;

/** Timers fired by hand, by their delay. */
class HandTimers implements Timers {
    private seq = 0;
    public readonly pending = new Map<number, {fn: () => void; ms: number}>();

    public setTimeout(fn: () => void, ms: number): TimerHandle {
        this.pending.set(++this.seq, {fn, ms});
        return this.seq;
    }
    public clearTimeout(handle: TimerHandle | null | undefined): void {
        if (handle != null) this.pending.delete(handle as number);
    }
    public setInterval(fn: () => void, ms: number): TimerHandle {
        return this.setTimeout(fn, ms);
    }
    public clearInterval(handle: TimerHandle | null | undefined): void {
        this.clearTimeout(handle);
    }
    /** Fire every timer set for `ms`. */
    public fire(ms: number): void {
        for (const [id, timer] of [...this.pending]) {
            if (timer.ms !== ms) continue;
            this.pending.delete(id);
            timer.fn();
        }
    }
}

interface Started {
    args: readonly string[];
    cwd: string;
    kills: string[];
    end(ending?: Partial<CommandEnding>): void;
}

/** A runner whose runs end when the test says. */
function handRunner(): CommandRunner & {started: Started[]} {
    const started: Started[] = [];
    return {
        started,
        run(args, cwd, _name, onDone) {
            const kills: string[] = [];
            started.push({
                args,
                cwd,
                kills,
                end: (ending = {}) =>
                    onDone({exitCode: 0, signal: null, stdout: '', stderr: '', startError: null, ...ending}),
            });
            return {kill: (signal) => void kills.push(signal)};
        },
    };
}

function resultJson(result: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({type: 'result', subtype: 'success', is_error: false, result, ...extra});
}

/** Lets the awaits inside a run (the week's usage, git) go through. */
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

let ids = 0;
const nextId = {newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`};

/** A temp home with one project holding `schedule-<slug>.md` files, and a transcript folder for it. */
function world(files: Record<string, string>) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedule-service-')));
    const projects = path.join(home, '.claude', 'projects');
    const project = path.join(home, 'app');
    const commands = path.join(project, '.claude', 'commands');
    fs.mkdirSync(commands, {recursive: true});
    for (const [slug, text] of Object.entries(files))
        fs.writeFileSync(path.join(commands, `schedule-${slug}.md`), text);
    const folder = encodeProjectPath(project);
    fs.mkdirSync(path.join(projects, folder), {recursive: true});
    fs.writeFileSync(path.join(projects, folder, 'old.jsonl'), JSON.stringify({type: 'user', cwd: project}) + '\n');
    const keyOf = (slug: string) => path.join(commands, `schedule-${slug}.md`);
    return {home, projects, project, commands, keyOf};
}

function schedule(frontmatter: string, body = 'Tidy up.'): string {
    return `---\n${frontmatter}\n---\n${body}\n`;
}

const NIGHTLY = schedule('name: Nightly\ncron: 0 3 * * *\nworktree: false');

function service(
    w: ReturnType<typeof world>,
    options: {now?: () => number; week?: number | null; git?: ScheduleServiceDeps['git']} = {},
) {
    const runs = new MemoryScheduleRunStore();
    const runner = handRunner();
    const timers = new HandTimers();
    const usageReads: number[] = [];
    let clock = THREE_AM;
    const week = options.week === undefined ? 40 : options.week;
    const usage = {
        fetch: async (): Promise<Usage> => {
            usageReads.push(clock);
            return week === null ? {_rateLimited: true} : {weekAll: week};
        },
    };
    const engine = new ScheduleService({
        fs: new NodeFileSystem(),
        transcripts: new FileTranscriptStore(new NodeFileSystem(), w.projects),
        repository: {getAllFolderMeta: () => new Map()},
        runner,
        ids: nextId,
        clock: {now: () => options.now?.() ?? clock},
        timers,
        log: silentLog,
        commandsDir: path.join(w.home, '.claude', 'commands'),
        runs,
        usage,
        git: options.git,
    });
    const changes: number[] = [];
    engine.onChanged(() => changes.push(1));
    return {
        engine,
        runs,
        runner,
        timers,
        usageReads,
        changes,
        setNow: (at: number) => void (clock = at),
        /** Turn a schedule on the way the manager does: record its prompt's first version. */
        turnOn: (slug: string, at = THREE_AM - 60 * MINUTE) => runs.versionFor(w.keyOf(slug), 'Tidy up.', at, null),
    };
}

/** Start the loop half a minute before 03:00 and fire its first tick, at 03:00. */
async function tickAtThree(s: ReturnType<typeof service>) {
    s.setNow(THREE_AM - MINUTE / 2);
    s.engine.start();
    s.setNow(THREE_AM);
    s.timers.fire(MINUTE / 2);
    await flush();
}

// ── Listing ──

test('every schedule file is listed, on or off, with its settings, and one never turned on is new', () => {
    /* Given */
    const w = world({
        nightly: schedule(
            'name: Nightly\ncron: 0 3 * * *\nmissed: skip\nlimit-minutes: 20\nweek-cap: 60%\nworktree: false\ncli:\n  model: sonnet',
        ),
        off: schedule('name: Off\ncron: 0 4 * * *\nenabled: false'),
    });
    const s = service(w);
    s.turnOn('nightly');

    /* When */
    const entries = s.engine.all().sort((a, b) => a.key.localeCompare(b.key));

    /* Then */
    assert.deepEqual(
        entries.map((e) => [path.basename(e.key), e.isNew, e.runsOn.kind]),
        [
            ['schedule-nightly.md', false, 'mac'],
            ['schedule-off.md', true, 'mac'],
        ],
    );
    assert.deepEqual(entries[0].settings, {
        name: 'Nightly',
        slug: 'nightly',
        projectPath: w.project,
        cron: '0 3 * * *',
        enabled: true,
        prompt: 'Tidy up.',
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        allowedTools: 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch',
        limitMinutes: 20,
        weekCap: 60,
        missed: 'skip',
        worktree: false,
    });
    assert.deepEqual(
        [entries[1].settings.enabled, entries[1].settings.limitMinutes, entries[1].settings.weekCap],
        [false, 30, 80],
    );
    assert.equal(entries[1].settings.worktree, true);
});

// ── The tick ──

test('a new schedule is not run by the tick, however due', async () => {
    /* Given */
    const w = world({nightly: NIGHTLY});
    const s = service(w);

    /* When */
    await tickAtThree(s);

    /* Then */
    assert.equal(s.runner.started.length, 0);
    assert.deepEqual(s.runs.runsOf(w.keyOf('nightly'), 10), []);
});

test('a turned-on schedule runs at its time and is recorded running, then done with its report and the week', async () => {
    /* Given */
    const w = world({nightly: NIGHTLY});
    const s = service(w);
    s.turnOn('nightly');

    /* When */
    await tickAtThree(s);
    const running = s.runs.runsOf(w.keyOf('nightly'), 10)[0];
    s.setNow(THREE_AM + 5 * MINUTE);
    s.runner.started[0].end({stdout: 'Welcome to zsh\n' + resultJson('Bumped two packages.')});
    await flush();

    /* Then */
    assert.equal(running.status, 'running');
    assert.equal(s.engine.isRunning(w.keyOf('nightly')), false);
    const [run] = s.runs.runsOf(w.keyOf('nightly'), 10);
    assert.deepEqual(
        {...run, id: '', sessionId: ''},
        {
            id: '',
            scheduleKey: w.keyOf('nightly'),
            sessionId: '',
            trigger: 'cron',
            dueAt: THREE_AM,
            startedAt: THREE_AM,
            endedAt: THREE_AM + 5 * MINUTE,
            status: 'done',
            reason: null,
            promptVersion: 1,
            report: 'Bumped two packages.',
            weekBefore: 40,
            weekAfter: 40,
            worktree: null,
            seen: false,
        },
    );
    const started = s.runner.started[0];
    assert.equal(started.cwd, w.project);
    assert.equal(started.args[started.args.indexOf('--resume') + 1], run.sessionId);
    const seed = path.join(w.projects, encodeProjectPath(w.project), `${run.sessionId}.jsonl`);
    assert.equal(JSON.parse(fs.readFileSync(seed, 'utf8')).cwd, w.project);
    assert.deepEqual(s.usageReads, [THREE_AM, THREE_AM + 5 * MINUTE]);
    assert.ok(s.changes.length >= 2);
});

test('a run that found nothing to do arrives seen', async () => {
    /* Given */
    const w = world({nightly: NIGHTLY});
    const s = service(w);
    s.turnOn('nightly');
    await tickAtThree(s);

    /* When */
    s.runner.started[0].end({stdout: resultJson('Nothing to do.\nNo open PRs.')});
    await flush();

    /* Then */
    const [run] = s.runs.runsOf(w.keyOf('nightly'), 10);
    assert.deepEqual([run.status, run.seen], ['done', true]);
});

test('a run that exits non-zero is failed, with the exit and the last line of stderr', async () => {
    /* Given */
    const w = world({nightly: NIGHTLY});
    const s = service(w);
    s.turnOn('nightly');
    await tickAtThree(s);

    /* When */
    s.runner.started[0].end({exitCode: 1, stderr: 'warming up\nAPI Error: overloaded\n'});
    await flush();

    /* Then */
    const [run] = s.runs.runsOf(w.keyOf('nightly'), 10);
    assert.deepEqual([run.status, run.reason], ['failed', 'exit 1: API Error: overloaded']);
});

test('a disabled schedule is not run', async () => {
    /* Given */
    const w = world({nightly: schedule('name: Nightly\ncron: 0 3 * * *\nenabled: false\nworktree: false')});
    const s = service(w);
    s.turnOn('nightly');

    /* When */
    await tickAtThree(s);

    /* Then */
    assert.equal(s.runner.started.length, 0);
});

// ── Skips ──

test('a cron time while the previous run is still going is recorded skipped', async () => {
    /* Given */
    const w = world({often: schedule('name: Often\ncron: * * * * *\nworktree: false')});
    const s = service(w);
    s.turnOn('often', THREE_AM);
    await tickAtThree(s);

    /* When */
    s.setNow(THREE_AM + MINUTE);
    s.timers.fire(MINUTE);
    await flush();

    /* Then */
    const [latest, first] = s.runs.runsOf(w.keyOf('often'), 10);
    assert.deepEqual(
        [latest.status, latest.reason, latest.dueAt, latest.seen],
        ['skipped', 'the previous run was still going', THREE_AM + MINUTE, false],
    );
    assert.equal(first.status, 'running');
    assert.equal(s.runner.started.length, 1);
});

test('Skip skips the next cron time only', async () => {
    /* Given */
    const w = world({often: schedule('name: Often\ncron: * * * * *\nworktree: false')});
    const s = service(w);
    s.turnOn('often', THREE_AM);
    assert.deepEqual(s.engine.skipNext(w.keyOf('often')), {ok: true});

    /* When */
    await tickAtThree(s);
    s.setNow(THREE_AM + MINUTE);
    s.timers.fire(MINUTE);
    await flush();

    /* Then */
    const [second, first] = s.runs.runsOf(w.keyOf('often'), 10);
    assert.deepEqual([first.status, first.reason], ['skipped', 'you pressed Skip tonight']);
    assert.equal(second.status, 'running');
});

test('a week past the cap skips the run; an unknown week does not', async () => {
    /* Given */
    const w = world({nightly: schedule('name: Nightly\ncron: 0 3 * * *\nweek-cap: 80\nworktree: false')});
    const past = service(w, {week: 84});
    past.turnOn('nightly');
    const unknown = service(w, {week: null});
    unknown.turnOn('nightly');

    /* When */
    await tickAtThree(past);
    await tickAtThree(unknown);

    /* Then */
    const [run] = past.runs.runsOf(w.keyOf('nightly'), 10);
    assert.deepEqual(
        [run.status, run.reason, run.weekBefore, run.startedAt, past.runner.started.length],
        ['skipped', 'the week was at 84%, past its 80% cap', 84, null, 0],
    );
    assert.equal(unknown.runner.started.length, 1);
    assert.equal(unknown.runs.runsOf(w.keyOf('nightly'), 10)[0].weekBefore, null);
});

// ── Run now ──

test('Run now runs a schedule that is off and new, past the cap, and refuses a second while it runs', async () => {
    /* Given */
    const w = world({off: schedule('name: Off\ncron: 0 4 * * *\nenabled: false\nworktree: false')});
    const s = service(w, {week: 95});

    /* When */
    const first = s.engine.runNow(w.keyOf('off'), 'manual');
    await flush();
    const second = s.engine.runNow(w.keyOf('off'), 'try');

    /* Then */
    assert.deepEqual(first, {ok: true});
    assert.ok('error' in second);
    assert.equal(s.engine.isRunning(w.keyOf('off')), true);
    const [run] = s.runs.runsOf(w.keyOf('off'), 10);
    assert.deepEqual([run.trigger, run.status, run.dueAt, run.promptVersion], ['manual', 'running', null, 1]);
    assert.equal(s.runs.versionsOf(w.keyOf('off'))[0].note, 'edited outside Switchboard');
    assert.ok('error' in s.engine.runNow(w.keyOf('gone'), 'manual'));
});

// ── The time limit ──

test('a run past its limit gets SIGTERM, SIGKILL after the grace, and is recorded stopped by its limit', async () => {
    /* Given */
    const w = world({slow: schedule('name: Slow\ncron: 0 3 * * *\nlimit-minutes: 20\nworktree: false')});
    const s = service(w);
    s.turnOn('slow');
    await tickAtThree(s);
    const started = s.runner.started[0];

    /* When */
    s.timers.fire(20 * MINUTE);
    const afterTerm = [...started.kills];
    s.timers.fire(KILL_GRACE_MS);
    started.end({exitCode: null, signal: 'SIGKILL'});
    await flush();

    /* Then */
    assert.deepEqual(afterTerm, ['SIGTERM']);
    assert.deepEqual(started.kills, ['SIGTERM', 'SIGKILL']);
    const [run] = s.runs.runsOf(w.keyOf('slow'), 10);
    assert.deepEqual([run.status, run.reason], ['limit', 'its 20 min limit']);
});

test('a run that ends in time leaves no limit timer behind', async () => {
    /* Given */
    const w = world({slow: schedule('name: Slow\ncron: 0 3 * * *\nlimit-minutes: 20\nworktree: false')});
    const s = service(w);
    s.turnOn('slow');
    await tickAtThree(s);

    /* When */
    s.runner.started[0].end({stdout: resultJson('Done.')});
    await flush();

    /* Then */
    assert.deepEqual(
        [...s.timers.pending.values()].map((t) => t.ms),
        [MINUTE],
    );
});

// ── The worktree ──

test('with worktree on, a run works in a fresh worktree off origin’s default branch, seeded there', async () => {
    /* Given */
    const w = world({nightly: schedule('name: Nightly\ncron: 0 3 * * *')});
    const added: [string, string, string, string][] = [];
    const ok: GitWrite = {ok: true};
    const git = {
        worktreeRoot: async (cwd: string) => cwd,
        defaultBranch: async () => 'main',
        commitSha: async (_: string, ref: string) => (ref === 'origin/main' ? 'abc' : null),
        fetchBranch: async () => ok,
        addWorktree: async (repository: string, at: string, branch: string, base: string) => {
            added.push([repository, at, branch, base]);
            fs.mkdirSync(at, {recursive: true});
            return ok;
        },
    };
    const s = service(w, {git});
    s.turnOn('nightly');

    /* When */
    await tickAtThree(s);

    /* Then */
    const worktree = path.join(w.project, '.claude', 'worktrees', 'schedule-nightly-20261103-0300');
    assert.deepEqual(added, [[w.project, worktree, 'schedule/nightly-20261103-0300', 'origin/main']]);
    const [run] = s.runs.runsOf(w.keyOf('nightly'), 10);
    assert.equal(run.worktree, worktree);
    assert.equal(s.runner.started[0].cwd, worktree);
    const seed = path.join(w.projects, encodeProjectPath(worktree), `${run.sessionId}.jsonl`);
    assert.equal(JSON.parse(fs.readFileSync(seed, 'utf8')).cwd, worktree);
});

test('a worktree git refuses fails the run with git’s reason', async () => {
    /* Given */
    const w = world({nightly: schedule('name: Nightly\ncron: 0 3 * * *')});
    const git = {
        worktreeRoot: async (cwd: string) => cwd,
        defaultBranch: async () => 'main',
        commitSha: async () => 'abc',
        fetchBranch: async (): Promise<GitWrite> => ({ok: true}),
        addWorktree: async (): Promise<GitWrite> => ({ok: false, reason: 'already exists'}),
    };
    const s = service(w, {git});
    s.turnOn('nightly');

    /* When */
    await tickAtThree(s);

    /* Then */
    const [run] = s.runs.runsOf(w.keyOf('nightly'), 10);
    assert.deepEqual(
        [run.status, run.reason, s.runner.started.length],
        ['failed', 'its worktree could not be made: already exists', 0],
    );
    assert.equal(s.engine.isRunning(w.keyOf('nightly')), false);
});

// ── Missed times and a quit mid-run ──

test('on start, the latest missed time of a run-once schedule is run once as a catch-up', async () => {
    /* Given */
    const w = world({nightly: NIGHTLY});
    const s = service(w);
    s.turnOn('nightly', THREE_AM - 3 * 24 * 60 * MINUTE);
    s.setNow(THREE_AM + 4 * 60 * MINUTE);

    /* When */
    s.engine.start();
    await flush();

    /* Then */
    const runs = s.runs.runsOf(w.keyOf('nightly'), 10);
    assert.equal(runs.length, 1);
    assert.deepEqual(
        [runs[0].trigger, runs[0].dueAt, runs[0].status, runs[0].reason],
        ['catch-up', THREE_AM, 'running', 'Switchboard was not running at 03:00, ran on start'],
    );
    assert.equal(s.runner.started.length, 1);
});

test('on wake, a skip schedule’s missed time is recorded missed, once', async () => {
    /* Given */
    const w = world({nightly: schedule('name: Nightly\ncron: 0 3 * * *\nmissed: skip\nworktree: false')});
    const s = service(w);
    s.turnOn('nightly');
    s.setNow(THREE_AM + 4 * 60 * MINUTE);

    /* When */
    s.engine.catchUp('wake');
    s.engine.catchUp('wake');

    /* Then */
    const runs = s.runs.runsOf(w.keyOf('nightly'), 10);
    assert.equal(runs.length, 1);
    assert.deepEqual(
        [runs[0].status, runs[0].dueAt, runs[0].reason, runs[0].seen],
        ['missed', THREE_AM, 'the Mac was asleep at 03:00', false],
    );
    assert.equal(s.runner.started.length, 0);
});

test('a time from before the schedule was turned on is not owed', () => {
    /* Given */
    const w = world({nightly: NIGHTLY});
    const s = service(w);
    s.turnOn('nightly', THREE_AM + 60 * MINUTE);
    s.setNow(THREE_AM + 4 * 60 * MINUTE);

    /* When */
    s.engine.catchUp('wake');

    /* Then */
    assert.deepEqual(s.runs.runsOf(w.keyOf('nightly'), 10), []);
});

test('on start, runs a quit left running are failed', () => {
    /* Given */
    const w = world({nightly: NIGHTLY});
    const s = service(w);
    s.turnOn('nightly', THREE_AM);
    s.runs.add({
        id: 'left',
        scheduleKey: w.keyOf('nightly'),
        sessionId: 's',
        trigger: 'cron',
        dueAt: THREE_AM,
        startedAt: THREE_AM,
        endedAt: null,
        status: 'running',
        reason: null,
        promptVersion: 1,
        report: null,
        weekBefore: null,
        weekAfter: null,
        worktree: null,
        seen: false,
    });

    /* When */
    s.engine.start();

    /* Then */
    const run = s.runs.get('left');
    assert.deepEqual([run?.status, run?.reason, run?.endedAt], ['failed', 'Switchboard quit during the run', THREE_AM]);
});

test('an old creator command that still points at the brain tab is replaced, an edited one is kept', () => {
    /* Given */
    const old = world({});
    const commandsDir = path.join(old.home, '.claude', 'commands');
    fs.mkdirSync(commandsDir, {recursive: true});
    fs.writeFileSync(path.join(commandsDir, 'create-switchboard-schedule.md'), 'It will appear in the brain tab.');
    const edited = world({});
    const editedDir = path.join(edited.home, '.claude', 'commands');
    fs.mkdirSync(editedDir, {recursive: true});
    fs.writeFileSync(path.join(editedDir, 'create-switchboard-schedule.md'), 'My own version.');

    /* When */
    service(old).engine.ensureCreatorCommand();
    service(edited).engine.ensureCreatorCommand();

    /* Then */
    const replaced = fs.readFileSync(path.join(commandsDir, 'create-switchboard-schedule.md'), 'utf8');
    assert.equal(replaced, SCHEDULE_CREATOR_TEMPLATE);
    assert.equal(fs.readFileSync(path.join(editedDir, 'create-switchboard-schedule.md'), 'utf8'), 'My own version.');
});
