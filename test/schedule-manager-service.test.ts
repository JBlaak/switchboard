/**
 * The Schedule manager's service against fakes: the facts it builds and
 * pushes, saving a schedule's file (new, edited, renamed, refused), turning
 * one on, runs, drafting with Claude from a sentence or a session, and the
 * wake.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    CREATED_NOTE,
    DRAFT_TIMEOUT_MS,
    ScheduleManagerService,
    WRITTEN_OUTSIDE_NOTE,
} from '../src/application/services/schedule-manager-service';
import {parseFrontmatter} from '../src/domain/schedule/support/frontmatter';
import {fakeTimers, silentLog} from './support/fakes';
import type {ScheduleManagerServiceDeps} from '../src/application/services/schedule-manager-service';
import type {ScheduleEngine, ScheduleEntry} from '../src/application/services/schedule-engine';
import type {ScheduleRunStore} from '../src/application/ports/schedule-runs';
import type {ClaudeRun} from '../src/domain/ask/route';
import type {
    PromptVersion,
    ScheduleActionResult,
    ScheduleManagerFacts,
    ScheduleRun,
    ScheduleSettings,
} from '../src/domain/schedule/manager';

const APP = '/Users/me/code/app';
const COMMANDS = `${APP}/.claude/commands`;
const KEY = `${COMMANDS}/schedule-nightly-check.md`;
const NOW = new Date(2026, 10, 25, 14, 0).getTime();

const SETTINGS: ScheduleSettings = {
    name: 'Nightly check',
    slug: 'nightly-check',
    projectPath: APP,
    cron: '0 3 * * *',
    enabled: true,
    prompt: 'Check.',
    model: null,
    permissionMode: 'acceptEdits',
    allowedTools: 'Read',
    limitMinutes: 30,
    weekCap: 80,
    missed: 'run-once',
    worktree: true,
};

// ── Fakes ──

class MemoryRuns implements ScheduleRunStore {
    public readonly runs: ScheduleRun[] = [];
    public readonly versions = new Map<string, PromptVersion[]>();
    public readonly rekeyed: [string, string][] = [];

    public add(run: ScheduleRun): void {
        this.runs.unshift(run);
    }
    public update(id: string, change: Partial<ScheduleRun>): void {
        const i = this.runs.findIndex((r) => r.id === id);
        if (i >= 0) this.runs[i] = {...this.runs[i], ...change};
    }
    public get(id: string): ScheduleRun | null {
        return this.runs.find((r) => r.id === id) ?? null;
    }
    public runsOf(key: string, limit: number): ScheduleRun[] {
        return this.runs.filter((r) => r.scheduleKey === key).slice(0, limit);
    }
    public runsSince(since: number): ScheduleRun[] {
        return this.runs.filter((r) => (r.startedAt ?? r.dueAt ?? 0) >= since);
    }
    public runningRuns(): ScheduleRun[] {
        return this.runs.filter((r) => r.status === 'running');
    }
    public hasRunFor(key: string, dueAt: number): boolean {
        return this.runs.some((r) => r.scheduleKey === key && r.dueAt === dueAt);
    }
    public markAllSeen(): number {
        let n = 0;
        this.runs.forEach((r, i) => {
            if (!r.seen && r.status !== 'running') {
                this.runs[i] = {...r, seen: true};
                n++;
            }
        });
        return n;
    }
    public lastStatuses(key: string, limit: number): ScheduleRun['status'][] {
        return this.runsOf(key, limit)
            .reverse()
            .map((r) => r.status);
    }
    public versionsOf(key: string): PromptVersion[] {
        return this.versions.get(key) ?? [];
    }
    public versionFor(key: string, text: string, savedAt: number, note: string | null): number {
        const list = this.versions.get(key) ?? [];
        if (list[0]?.text === text) return list[0].version;
        const version = (list[0]?.version ?? 0) + 1;
        this.versions.set(key, [{version, text, savedAt, note}, ...list]);
        return version;
    }
    public rekey(from: string, to: string): void {
        this.rekeyed.push([from, to]);
        const list = this.versions.get(from);
        if (list) this.versions.set(to, list);
        this.versions.delete(from);
    }
}

function memoryFs(files: Record<string, string> = {}, dirs: string[] = [APP]) {
    const store = new Map(Object.entries(files));
    const folders = new Set(dirs);
    const fs: ScheduleManagerServiceDeps['fs'] = {
        exists: (p) => store.has(p) || folders.has(p),
        isDirectory: (p) => folders.has(p),
        readText: (p) => {
            const text = store.get(p);
            if (text === undefined) throw new Error(`ENOENT ${p}`);
            return text;
        },
        writeText: (p, text) => {
            store.set(p, text);
        },
        makeDir: (p) => {
            folders.add(p);
        },
        remove: (p) => {
            store.delete(p);
        },
        join: (...parts) => parts.join('/'),
        dirname: (p) => p.slice(0, p.lastIndexOf('/')),
    };
    return {fs, store};
}

function fakeEngine(entries: ScheduleEntry[] = []) {
    const calls: unknown[][] = [];
    const listeners: (() => void)[] = [];
    let running = new Set<string>();
    let answer: ScheduleActionResult = {ok: true};
    const engine: ScheduleEngine = {
        all: () => entries,
        runNow: (key, trigger) => {
            calls.push(['runNow', key, trigger]);
            return answer;
        },
        skipNext: (key) => {
            calls.push(['skipNext', key]);
            return answer;
        },
        isRunning: (key) => running.has(key),
        onChanged: (cb) => {
            listeners.push(cb);
            return () => listeners.splice(listeners.indexOf(cb), 1);
        },
    };
    return {
        engine,
        calls,
        entries,
        change: () => listeners.forEach((cb) => cb()),
        setRunning: (keys: string[]) => (running = new Set(keys)),
        answer: (a: ScheduleActionResult) => (answer = a),
        get listening() {
            return listeners.length;
        },
    };
}

function entry(
    fields: Omit<Partial<ScheduleEntry>, 'settings'> & {settings?: Partial<ScheduleSettings>} = {},
): ScheduleEntry {
    return {
        key: fields.key ?? KEY,
        settings: {...SETTINGS, ...fields.settings},
        runsOn: fields.runsOn ?? {kind: 'mac'},
        isNew: fields.isNew ?? false,
    };
}

function run(fields: Partial<ScheduleRun> = {}): ScheduleRun {
    return {
        id: 'run-1',
        scheduleKey: KEY,
        sessionId: 's',
        trigger: 'cron',
        dueAt: NOW - 11 * 3600_000,
        startedAt: NOW - 11 * 3600_000,
        endedAt: NOW - 10 * 3600_000,
        status: 'done',
        reason: null,
        promptVersion: 1,
        report: 'Done.',
        weekBefore: 10,
        weekAfter: 12,
        worktree: null,
        seen: true,
        ...fields,
    };
}

function answered(result: unknown): ClaudeRun {
    return {
        exitCode: 0,
        stdout: JSON.stringify({type: 'result', is_error: false, result: JSON.stringify(result)}),
        stderr: '',
    };
}

const DRAFT_ANSWER = {
    name: 'Nightly dependency check',
    slug: 'nightly-dependency-check',
    cron: '20 3 * * *',
    whenReason: 'every night',
    prompt: 'Check the dependencies.',
    allowedTools: 'Read',
    projectPath: APP,
};

function setup(
    options: {
        entries?: ScheduleEntry[];
        files?: Record<string, string>;
        dirs?: string[];
        wake?: string | null;
        week?: number | null;
        claude?: (args: readonly string[], signal: AbortSignal) => Promise<ClaudeRun>;
        transcript?: {head: string[]; tail: string};
    } = {},
) {
    const engine = fakeEngine(options.entries ?? []);
    const runs = new MemoryRuns();
    const {fs, store} = memoryFs(options.files ?? {}, options.dirs);
    const pushed: ScheduleManagerFacts[] = [];
    const archived: string[] = [];
    const wakeCalls: (string | null)[] = [];
    let wakeAt = options.wake ?? null;
    let wakeReads = 0;
    let wakeAnswer: ScheduleActionResult = {ok: true};
    const claudeCalls: (readonly string[])[] = [];
    const timers = fakeTimers();
    const now = {value: NOW};
    const deps: ScheduleManagerServiceDeps = {
        engine: engine.engine,
        runs,
        fs,
        wake: {
            read: async () => {
                wakeReads++;
                return wakeAt;
            },
            set: async (at) => {
                wakeCalls.push(at);
                if ('ok' in wakeAnswer) wakeAt = at;
                return wakeAnswer;
            },
        },
        week: () => options.week ?? null,
        cli: {
            call: (args, signal) => {
                claudeCalls.push(args);
                return options.claude ? options.claude(args, signal) : Promise.resolve(answered(DRAFT_ANSWER));
            },
        },
        projects: () => [{projectPath: APP, recentTitles: []}],
        locate: (id) =>
            id === 'local'
                ? {folder: '-Users-me-code-app', projectPath: APP}
                : id === 'remote'
                  ? {folder: null, projectPath: 'ssh://box/app'}
                  : null,
        transcripts: {
            readHeadLines: () => options.transcript?.head ?? [],
            readTail: () => options.transcript?.tail ?? '',
        },
        renderer: {scheduleManagerChanged: (facts) => pushed.push(facts)},
        archive: (sessionId) => archived.push(sessionId),
        clock: {now: () => now.value},
        timers,
        log: silentLog,
    };
    const service = new ScheduleManagerService(deps);
    return {
        service,
        engine,
        runs,
        store,
        pushed,
        archived,
        wakeCalls,
        claudeCalls,
        timers,
        now,
        wakeAnswer: (a: ScheduleActionResult) => (wakeAnswer = a),
        get wakeReads() {
            return wakeReads;
        },
    };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── Facts ──

test('the facts hold each schedule with its runs, the recent runs, the wake and the week', async () => {
    /* Given */
    const world = setup({entries: [entry()], wake: '02:55', week: 41});
    world.runs.add(run({status: 'failed', seen: false}));

    /* When */
    const facts = await world.service.facts();

    /* Then */
    assert.equal(facts.schedules.length, 1);
    assert.equal(facts.schedules[0].group, 'needsYou');
    assert.deepEqual(facts.schedules[0].lastRuns, ['failed']);
    assert.equal(facts.recentRuns.length, 1);
    assert.equal(facts.wakeAt, '02:55');
    assert.equal(facts.suggestedWakeAt, '02:55');
    assert.equal(facts.week, 41);
});

test('a schedule the engine says is running is Running', async () => {
    /* Given */
    const world = setup({entries: [entry()]});
    world.engine.setRunning([KEY]);

    /* When */
    const facts = await world.service.facts();

    /* Then */
    assert.equal(facts.schedules[0].group, 'running');
});

test('the wake is read from pmset at most once a minute', async () => {
    /* Given */
    const world = setup({entries: [entry()]});
    await world.service.facts();

    /* When */
    await world.service.facts();
    world.now.value += 61_000;
    await world.service.facts();

    /* Then */
    assert.equal(world.wakeReads, 2);
});

test('starting pushes the facts, and so does every change the scheduler reports', async () => {
    /* Given */
    const world = setup({entries: [entry()]});

    /* When */
    world.service.start();
    await settle();
    world.engine.change();
    await settle();

    /* Then */
    assert.equal(world.pushed.length, 2);
});

test('stopping stops listening to the scheduler', () => {
    /* Given */
    const world = setup();
    world.service.start();

    /* When */
    world.service.stop();

    /* Then */
    assert.equal(world.engine.listening, 0);
});

test('a schedule’s page has its runs, versions and stats; a gone one has none', () => {
    /* Given */
    const world = setup({entries: [entry()]});
    world.runs.add(run());
    world.runs.versionFor(KEY, 'Check.', NOW, CREATED_NOTE);

    /* When */
    const detail = world.service.detail(KEY);
    const gone = world.service.detail('/nowhere.md');

    /* Then */
    assert.equal(detail?.runs.length, 1);
    assert.equal(detail?.versions[0].note, CREATED_NOTE);
    assert.equal(detail?.summary.promptVersion, 1);
    assert.equal(detail?.stats.total, 1);
    assert.equal(gone, null);
});

// ── Saving ──

test('a new schedule is written to its project’s commands folder as version 1', async () => {
    /* Given */
    const world = setup();

    /* When */
    const result = world.service.save(null, SETTINGS, null, false);
    await settle();

    /* Then */
    assert.deepEqual(result, {key: KEY});
    assert.equal(parseFrontmatter(world.store.get(KEY)!).meta.cron, '0 3 * * *');
    assert.deepEqual(
        world.runs.versionsOf(KEY).map((v) => [v.version, v.note]),
        [[1, CREATED_NOTE]],
    );
    assert.equal(world.pushed.length, 1);
});

test('a new schedule never overwrites another one’s file', () => {
    /* Given */
    const world = setup({files: {[KEY]: 'someone else’s'}});

    /* When */
    const result = world.service.save(null, SETTINGS, null, false);

    /* Then */
    assert.deepEqual(result, {error: 'This project already has a schedule saved as nightly-check'});
    assert.equal(world.store.get(KEY), 'someone else’s');
});

test('save and try starts a try run of the saved file', () => {
    /* Given */
    const world = setup();

    /* When */
    world.service.save(null, SETTINGS, null, true);

    /* Then */
    assert.deepEqual(world.engine.calls, [['runNow', KEY, 'try']]);
});

test('an edit keeps what the page does not know and records the changed prompt with its note', () => {
    /* Given */
    const existing = '---\nname: Nightly check\ncron: 0 3 * * *\nowner: me\ncli:\n  max-budget-usd: 2\n---\nCheck.\n';
    const world = setup({files: {[KEY]: existing}, entries: [entry()]});
    world.runs.versionFor(KEY, 'Check.', NOW - 1000, CREATED_NOTE);

    /* When */
    const result = world.service.save(KEY, {...SETTINGS, prompt: 'Check twice.'}, 'stricter', false);

    /* Then */
    assert.deepEqual(result, {key: KEY});
    const {meta, body} = parseFrontmatter(world.store.get(KEY)!);
    assert.equal(meta.owner, 'me');
    assert.equal((meta.cli as Record<string, string>)['max-budget-usd'], '2');
    assert.equal(body, 'Check twice.');
    assert.deepEqual(
        world.runs.versionsOf(KEY).map((v) => [v.version, v.note]),
        [
            [2, 'stricter'],
            [1, CREATED_NOTE],
        ],
    );
});

test('an edit with an unchanged prompt records no new version', () => {
    /* Given */
    const world = setup({files: {[KEY]: '---\nname: x\n---\nCheck.\n'}, entries: [entry()]});
    world.runs.versionFor(KEY, 'Check.', NOW - 1000, CREATED_NOTE);

    /* When */
    world.service.save(KEY, {...SETTINGS, cron: '0 4 * * *'}, null, false);

    /* Then */
    assert.equal(world.runs.versionsOf(KEY).length, 1);
});

test('a changed slug renames the file, and its runs and versions follow it', () => {
    /* Given */
    const world = setup({files: {[KEY]: '---\nname: x\n---\nCheck.\n'}, entries: [entry()]});
    const renamed = `${COMMANDS}/schedule-deps.md`;

    /* When */
    const result = world.service.save(KEY, {...SETTINGS, slug: 'deps'}, null, false);

    /* Then */
    assert.deepEqual(result, {key: renamed});
    assert.equal(world.store.has(KEY), false);
    assert.equal(parseFrontmatter(world.store.get(renamed)!).meta.slug, 'deps');
    assert.deepEqual(world.runs.rekeyed, [[KEY, renamed]]);
});

test('a rename onto another schedule’s file is refused and changes nothing', () => {
    /* Given */
    const other = `${COMMANDS}/schedule-deps.md`;
    const world = setup({files: {[KEY]: 'mine', [other]: 'theirs'}, entries: [entry()]});

    /* When */
    const result = world.service.save(KEY, {...SETTINGS, slug: 'deps'}, null, false);

    /* Then */
    assert.ok('error' in result);
    assert.equal(world.store.get(KEY), 'mine');
    assert.equal(world.store.get(other), 'theirs');
});

test('a cron the scheduler cannot read is not saved', () => {
    /* Given */
    const world = setup();

    /* When */
    const result = world.service.save(null, {...SETTINGS, cron: '0 3 * *'}, null, false);

    /* Then */
    assert.deepEqual(result, {error: '“0 3 * *” is not a time the scheduler can read'});
    assert.equal(world.store.size, 0);
});

test('a project that is not on this Mac is not saved into', () => {
    /* Given */
    const world = setup();

    /* When */
    const missing = world.service.save(null, {...SETTINGS, projectPath: '/Users/me/gone'}, null, false);
    const remote = world.service.save(null, {...SETTINGS, projectPath: 'ssh://box/app'}, null, false);

    /* Then */
    assert.deepEqual(missing, {error: 'That project is not on this Mac'});
    assert.deepEqual(remote, {error: 'That project is not on this Mac'});
});

test('an edit of a file that is gone says so', () => {
    /* Given */
    const world = setup();

    /* When */
    const result = world.service.save(KEY, SETTINGS, null, false);

    /* Then */
    assert.deepEqual(result, {error: 'That schedule’s file is gone'});
});

// ── On and off ──

test('turning a new schedule on writes enabled and records its first version', () => {
    /* Given: written by the slash command, never run */
    const text = '---\nname: Nightly check\ncron: 0 3 * * *\nenabled: false\n---\nCheck.\n';
    const world = setup({files: {[KEY]: text}, entries: [entry({isNew: true, settings: {enabled: false}})]});

    /* When */
    const result = world.service.setEnabled(KEY, true);

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.equal(parseFrontmatter(world.store.get(KEY)!).meta.enabled, 'true');
    assert.deepEqual(
        world.runs.versionsOf(KEY).map((v) => [v.version, v.note]),
        [[1, WRITTEN_OUTSIDE_NOTE]],
    );
});

test('turning a schedule off records no version', () => {
    /* Given */
    const world = setup({files: {[KEY]: '---\nenabled: true\n---\nCheck.\n'}, entries: [entry()]});

    /* When */
    world.service.setEnabled(KEY, false);

    /* Then */
    assert.equal(parseFrontmatter(world.store.get(KEY)!).meta.enabled, 'false');
    assert.equal(world.runs.versionsOf(KEY).length, 0);
});

// ── Runs ──

test('run now and skip next go to the scheduler and push', async () => {
    /* Given */
    const world = setup({entries: [entry()]});

    /* When */
    world.service.runNow(KEY);
    world.service.skipNext(KEY);
    await settle();

    /* Then */
    assert.deepEqual(world.engine.calls, [
        ['runNow', KEY, 'manual'],
        ['skipNext', KEY],
    ]);
    assert.equal(world.pushed.length, 2);
});

test('the scheduler’s refusal is answered as it is', () => {
    /* Given */
    const world = setup({entries: [entry()]});
    world.engine.answer({error: 'already running'});

    /* When */
    const result = world.service.runNow(KEY);

    /* Then */
    assert.deepEqual(result, {error: 'already running'});
});

test('marking a run seen updates it once and pushes', async () => {
    /* Given */
    const world = setup({entries: [entry()]});
    world.runs.add(run({status: 'failed', seen: false}));

    /* When */
    world.service.markSeen('run-1');
    world.service.markSeen('run-1');
    await settle();

    /* Then */
    assert.equal(world.runs.get('run-1')?.seen, true);
    assert.equal(world.pushed.length, 1);
});

test('marking all seen pushes only when something changed', async () => {
    /* Given */
    const world = setup({entries: [entry()]});
    world.runs.add(run({status: 'failed', seen: false}));

    /* When */
    world.service.markAllSeen();
    world.service.markAllSeen();
    await settle();

    /* Then */
    assert.equal(world.pushed.length, 1);
});

test('mark all read archives the sessions of the runs it marks, and only those', async () => {
    /* Given */
    const world = setup({entries: [entry()]});
    world.runs.add(run({id: 'unread', sessionId: 'night-run', status: 'failed', seen: false}));
    world.runs.add(run({id: 'opened', sessionId: 'opened-run', seen: true}));
    world.runs.add(run({id: 'going', sessionId: 'going-run', status: 'running', seen: false, endedAt: null}));

    /* When */
    world.service.markAllSeen();
    await settle();

    /* Then */
    assert.deepEqual(world.archived, ['night-run']);
});

// ── Drafting ──

test('a draft from a sentence asks Sonnet with the projects and the other schedules', async () => {
    /* Given */
    const world = setup({entries: [entry()]});

    /* When */
    const result = await world.service.draft('check deps every night', null);

    /* Then */
    assert.equal('draft' in result && result.draft.settings.cron, '20 3 * * *');
    const args = world.claudeCalls[0];
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    const prompt = args[args.length - 1];
    assert.match(prompt, /<projects>\n\/Users\/me\/code\/app\n<\/projects>/);
    assert.match(prompt, /0 3 \* \* \* {2}Nightly check/);
});

test('an empty sentence is not sent', async () => {
    /* Given */
    const world = setup();

    /* When */
    const result = await world.service.draft('  ', null);

    /* Then */
    assert.ok('error' in result);
    assert.equal(world.claudeCalls.length, 0);
});

test('a draft that takes too long is given up and its call killed', async () => {
    /* Given */
    let aborted = false;
    const world = setup({
        claude: (_args, signal) =>
            new Promise((resolve) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    resolve({exitCode: null, stdout: '', stderr: ''});
                });
            }),
    });
    const drafted = world.service.draft('check deps every night', null);

    /* When */
    world.timers.tick();
    const result = await drafted;

    /* Then */
    assert.deepEqual(result, {error: 'Claude took too long to draft it. Try again?'});
    assert.equal(aborted, true);
    assert.ok(DRAFT_TIMEOUT_MS >= 60_000);
});

test('a draft from a session sends what the user asked and what was done, in its project', async () => {
    /* Given */
    const line = (uuid: string, type: string, content: unknown) => JSON.stringify({type, uuid, message: {content}});
    const world = setup({
        transcript: {
            head: [line('u1', 'user', 'Bump the outdated deps and run the tests')],
            tail: [
                line('u1', 'user', 'Bump the outdated deps and run the tests'),
                line('a1', 'assistant', [{type: 'text', text: 'Bumped three, tests pass.'}]),
            ].join('\n'),
        },
    });

    /* When */
    const result = await world.service.draftFromSession('local');

    /* Then */
    assert.ok('draft' in result);
    const prompt = world.claudeCalls[0][world.claudeCalls[0].length - 1];
    assert.match(
        prompt,
        /<session>\nUser: Bump the outdated deps and run the tests\n\nClaude: Bumped three, tests pass.\n<\/session>/,
    );
    assert.match(prompt, /It runs in \/Users\/me\/code\/app/);
});

test('a session that is not on this Mac is not drafted from', async () => {
    /* Given */
    const world = setup();

    /* When */
    const remote = await world.service.draftFromSession('remote');
    const unknown = await world.service.draftFromSession('nobody');

    /* Then */
    assert.deepEqual(remote, {error: 'That session’s transcript is not on this Mac'});
    assert.deepEqual(unknown, {error: 'That session’s transcript is not on this Mac'});
    assert.equal(world.claudeCalls.length, 0);
});

test('a session with nothing in it yet is not drafted from', async () => {
    /* Given */
    const world = setup({transcript: {head: [], tail: ''}});

    /* When */
    const result = await world.service.draftFromSession('local');

    /* Then */
    assert.deepEqual(result, {error: 'That session has nothing to repeat yet'});
});

// ── The wake ──

test('setting the wake reads it back fresh and pushes it', async () => {
    /* Given */
    const world = setup({entries: [entry()]});
    await world.service.facts();

    /* When */
    const result = await world.service.setWake('02:55');
    await settle();

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(world.wakeCalls, ['02:55']);
    assert.equal(world.pushed.at(-1)?.wakeAt, '02:55');
});

test('a cancelled password prompt is answered as an error', async () => {
    /* Given */
    const world = setup();
    world.wakeAnswer({error: 'The password prompt was cancelled, so the wake was not changed'});

    /* When */
    const result = await world.service.setWake(null);

    /* Then */
    assert.deepEqual(result, {error: 'The password prompt was cancelled, so the wake was not changed'});
});

test('a wake that is not a time of day never reaches pmset', async () => {
    /* Given */
    const world = setup();

    /* When */
    const result = await world.service.setWake('3am');

    /* Then */
    assert.ok('error' in result);
    assert.deepEqual(world.wakeCalls, []);
});
