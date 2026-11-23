/**
 * Scheduled tasks: finding them, running them, recording each run, and
 * helping the user write one.
 *
 * The schedules themselves live in the projects, not in Switchboard — a
 * `schedule-*.md` under `.claude/commands/`, which makes each one both a cron
 * job and a slash command. So there is nothing to migrate: the tick rescans,
 * which also means a file edited by hand takes effect on the next minute. What
 * a file cannot hold, its runs and the versions of its prompt, goes to the run
 * store, keyed by the file's absolute path.
 *
 * Every run resumes a freshly seeded session rather than starting a bare one,
 * which is what groups a task's runs under a single slug in the sidebar. By
 * default it works in a fresh worktree of its own, off the default branch, so
 * a night's work never lands in the checkout the user has open.
 *
 * A schedule written outside Switchboard (the slash command, by hand) is new
 * until the Schedule manager turns it on by recording its first prompt
 * version; the tick does not run a new one. Without a run store (the agent on
 * a VM, whose runs are not recorded on the Mac) there is no manager to turn
 * one on, so every schedule counts as on.
 */
import {encodeProjectPath} from '../../domain/project/project-path';
import {cronMatches} from '../../domain/schedule/cron';
import {SCHEDULE_CREATOR_TEMPLATE} from '../../domain/schedule/creator-template';
import type {RunTrigger, ScheduleActionResult, ScheduleRun, ScheduleRunsOn} from '../../domain/schedule/manager';
import {catchUpReason, missedDecision, missedReason} from '../../domain/schedule/missed';
import type {CatchUpCause} from '../../domain/schedule/missed';
import {runOutcome} from '../../domain/schedule/outcome';
import {
    buildScheduleArgs,
    isScheduleFileName,
    parseSchedule,
    SCHEDULE_COMMANDS_SUBPATH,
    scheduleSettings,
    scheduleWorktree,
} from '../../domain/schedule/schedule';
import type {Schedule} from '../../domain/schedule/schedule';
import type {CommandEnding, CommandRunner, RunningCommand, UsageService} from '../ports/claude-cli';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {FileSystem} from '../ports/file-system';
import type {GitWorkspace, GitWorktrees} from '../ports/git-workspace';
import type {IdGenerator} from '../ports/ids';
import type {Logger} from '../ports/logger';
import type {ScheduleRunStore} from '../ports/schedule-runs';
import type {SessionRepository} from '../ports/session-repository';
import type {TranscriptStore} from '../ports/transcript-store';
import type {ScheduleEngine, ScheduleEntry} from './schedule-engine';
import {MemoryScheduleRunStore} from './support/memory-schedule-runs';

/** The cron loop's resolution. */
/** The cron loop's resolution. */
const TICK_MS = 60 * 1000;

/** How long a run's time limit waits after SIGTERM before it sends SIGKILL. */
export const KILL_GRACE_MS = 10_000;

/**
 * How long a reading of the week's usage is reused. The endpoint is rate
 * limited and several schedules often start in the same minute; one reading
 * serves them all.
 */
const WEEK_READING_MS = 60_000;

/** The note on a prompt version the scheduler records: the file changed without the manager. */
const EDITED_OUTSIDE = 'edited outside Switchboard';

export interface ScheduleServiceDeps {
    fs: FileSystem;
    transcripts: TranscriptStore;
    /**
     * Only for the index's folder → project mapping. The agent on a VM has no
     * index: it passes one with no folder meta, and every folder is resolved
     * from its transcripts instead.
     */
    repository: Pick<SessionRepository, 'getAllFolderMeta'>;
    runner: CommandRunner;
    ids: IdGenerator;
    clock: Clock;
    timers: Timers;
    log: Logger;
    /** `~/.claude/commands` — where the creator command is installed. */
    commandsDir: string;
    /**
     * Whether a project's schedules run on this machine (#276 stage 5). The
     * agent on a VM passes one that keeps only the copies in its host's
     * schedule folders, so a schedule runs either there or on the Mac, never
     * both. Absent, every project's schedules run, as on the Mac.
     */
    runsHere?: (projectPath: string) => boolean;
    /**
     * Projects to scan whether or not they have a transcript folder, absolute
     * (#276 stage 5). The scan finds projects through `~/.claude/projects`, so
     * a copy just handed off to a VM, with no session run there yet, would
     * otherwise have its schedules missed until one is. Each is scanned once,
     * however many transcript folders also resolve to it.
     */
    extraProjects?: () => readonly string[];
    /**
     * Where each run and prompt version is recorded. Absent (on a VM), they are
     * kept in memory only, and no schedule waits to be turned on.
     */
    runs?: ScheduleRunStore;
    /** The usage endpoint, for the week's share before and after a run. Absent, the week is unknown. */
    usage?: Pick<UsageService, 'fetch'>;
    /**
     * Archive a session, as the sidebar's archive does. A run that found
     * nothing to do is archived as it ends, so quiet nights don't fill Recent.
     */
    archive?: (sessionId: string) => void;
    /** For a run's own worktree. Absent, every run works in the project, as before. */
    git?: Pick<GitWorkspace, 'worktreeRoot' | 'defaultBranch' | 'commitSha'> &
        Pick<GitWorktrees, 'fetchBranch' | 'addWorktree'>;
    /** The VM a project's schedules run on instead, when `runsHere` says they don't run here. */
    vmHostOf?: (projectPath: string) => string | null;
}

/** One project to look for schedules in, and the transcript folder its runs are seeded in. */
interface ScanTarget {
    projectPath: string;
    folder: string;
}

/** A run going now: what stops it. */
interface LiveRun {
    runId: string;
    command: RunningCommand | null;
    limitTimer: TimerHandle | null;
    killTimer: TimerHandle | null;
    limitHit: boolean;
}

export class ScheduleService implements ScheduleEngine {
    private readonly runs: ScheduleRunStore;
    /** Whether a schedule waits for the manager to turn it on: only where its runs are recorded. */
    private readonly turnOnFirst: boolean;
    /** By schedule key: the run going now. One run of a schedule at a time. */
    private readonly live = new Map<string, LiveRun>();
    /** Schedules whose next cron time is skipped. Kept in memory: a restart forgets a Skip. */
    private readonly skipping = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private weekReading: {at: number; value: Promise<number | null>} | null = null;

    constructor(private readonly deps: ScheduleServiceDeps) {
        this.runs = deps.runs ?? new MemoryScheduleRunStore();
        this.turnOnFirst = deps.runs !== undefined;
    }

    /**
     * Every schedule across every project that runs here, on or off, one per
     * transcript folder its project has.
     *
     * The folder → project-path mapping comes from the index rather than by
     * re-reading a transcript per project: this runs every 60 seconds, and
     * parsing 4KB of every project's history each time was the whole cost of the
     * feature.
     */
    public scan(): Schedule[] {
        const schedules: Schedule[] = [];
        for (const target of this.targets(true)) schedules.push(...this.schedulesIn(target));
        return schedules;
    }

    // ── The engine, for the Schedule manager ──

    public all(): ScheduleEntry[] {
        return this.files(false).map((schedule) => this.entry(schedule));
    }

    public runNow(key: string, trigger: Extract<RunTrigger, 'manual' | 'try'>): ScheduleActionResult {
        const schedule = this.files(false).find((s) => s.filePath === key);
        if (!schedule) return {error: 'That schedule file is gone.'};
        const runsOn = this.runsOn(schedule.projectPath);
        if (runsOn.kind === 'vm') return {error: `It runs on ${runsOn.host}, not on this Mac.`};
        if (this.live.has(key)) return {error: 'It is running now.'};
        this.begin(schedule, trigger, null, null);
        return {ok: true};
    }

    public skipNext(key: string): ScheduleActionResult {
        if (!this.files(false).some((s) => s.filePath === key)) return {error: 'That schedule file is gone.'};
        this.skipping.add(key);
        this.changed();
        return {ok: true};
    }

    public isRunning(key: string): boolean {
        return this.live.has(key);
    }

    public onChanged(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    // ── The loop ──

    /**
     * Start the cron loop, and answer with the function that stops it.
     *
     * Runs a Switchboard that quit mid-run left `running` are failed first, and
     * the times missed while it was not running are caught up. The first tick
     * is aligned to the next minute boundary so a schedule set for `09:00` runs
     * at `09:00:00`-ish rather than at whatever second the app happened to
     * launch on.
     */
    public start(): () => void {
        const {timers, clock, log} = this.deps;
        let running = true;
        let interval: unknown = null;

        this.recoverInterrupted();
        this.catchUp('start');

        const tick = (): void => {
            if (!running) return;
            try {
                this.tick(clock.now());
            } catch (err) {
                log.error('[schedule] tick failed:', (err as Error).message);
            }
        };

        const msUntilNextMinute = TICK_MS - (clock.now() % TICK_MS);
        const initial = timers.setTimeout(() => {
            tick();
            interval = timers.setInterval(tick, TICK_MS);
        }, msUntilNextMinute);

        return () => {
            running = false;
            timers.clearTimeout(initial);
            timers.clearInterval(interval);
        };
    }

    /**
     * Look back for cron times slept through: on start, and when the Mac wakes.
     * Each enabled schedule that runs here owes at most its latest missed time
     * in the last week: run once now, or recorded missed, as its file says.
     */
    public catchUp(cause: CatchUpCause): void {
        const {clock, ids, log} = this.deps;
        const now = clock.now();
        for (const schedule of this.runnable()) {
            const key = schedule.filePath;
            const versions = this.runs.versionsOf(key);
            const decision = missedDecision({
                cron: schedule.cron,
                missed: schedule.missed,
                now,
                firstVersionAt: versions.length > 0 ? versions[versions.length - 1].savedAt : null,
                hasRunFor: (dueAt) => this.runs.hasRunFor(key, dueAt),
            });
            if (decision.kind === 'none' || this.live.has(key)) continue;
            if (decision.kind === 'catch-up') {
                log.info(`[schedule] catching up ${schedule.name} (${cause})`);
                this.begin(schedule, 'catch-up', decision.dueAt, catchUpReason(cause, decision.dueAt));
                continue;
            }
            this.record({
                ...this.blankRun(ids.newId(), schedule, 'cron', decision.dueAt, now),
                status: 'missed',
                endedAt: now,
                reason: missedReason(cause, decision.dueAt),
            });
        }
    }

    /** One minute: every schedule on, turned on and due now that has no run for this minute yet. */
    private tick(now: number): void {
        const {log} = this.deps;
        const minute = now - (now % TICK_MS);
        const at = new Date(now);
        for (const schedule of this.runnable()) {
            if (!cronMatches(schedule.cron, at)) continue;
            if (this.runs.hasRunFor(schedule.filePath, minute)) continue;
            log.info(`[schedule] triggering: ${schedule.name} (${schedule.cron})`);
            try {
                this.begin(schedule, 'cron', minute, null);
            } catch (err) {
                log.error(`[schedule] could not run ${schedule.name}:`, (err as Error).message);
            }
        }
    }

    /** Runs left `running` by a Switchboard that quit or crashed mid-run. */
    private recoverInterrupted(): void {
        const now = this.deps.clock.now();
        for (const run of this.runs.runningRuns()) {
            if (this.live.has(run.scheduleKey)) continue;
            this.change(run.id, {status: 'failed', reason: 'Switchboard quit during the run', endedAt: now});
        }
    }

    // ── One run ──

    /**
     * Record a run and start it, or record why it did not start: the
     * previous run still going, or a Skip pressed for this cron time.
     */
    private begin(schedule: Schedule, trigger: RunTrigger, dueAt: number | null, reason: string | null): void {
        const {clock, ids} = this.deps;
        const key = schedule.filePath;
        const now = clock.now();
        const blank = this.blankRun(ids.newId(), schedule, trigger, dueAt, now);
        const scheduled = trigger === 'cron' || trigger === 'catch-up';

        if (this.live.has(key)) {
            this.record({...blank, status: 'skipped', endedAt: now, reason: 'the previous run was still going'});
            return;
        }
        if (scheduled && this.skipping.delete(key)) {
            this.record({...blank, status: 'skipped', endedAt: now, reason: 'you pressed Skip tonight'});
            return;
        }

        const live: LiveRun = {runId: blank.id, command: null, limitTimer: null, killTimer: null, limitHit: false};
        this.live.set(key, live);
        this.record({...blank, status: 'running', startedAt: now, reason});
        this.execute(schedule, live, scheduled).catch((err: Error) =>
            this.finish(key, live, {status: 'failed', reason: err.message || 'it failed', endedAt: clock.now()}),
        );
    }

    /** The week check, the worktree, the seeded session and the process, in that order. */
    private async execute(schedule: Schedule, live: LiveRun, scheduled: boolean): Promise<void> {
        const {clock, ids, transcripts, runner, timers, log} = this.deps;
        const key = schedule.filePath;

        const weekBefore = await this.week();
        // A run asked for by hand goes ahead whatever the week: the user is there to judge it.
        if (scheduled && schedule.weekCap !== null && weekBefore !== null && weekBefore > schedule.weekCap) {
            const reason = `the week was at ${Math.round(weekBefore)}%, past its ${schedule.weekCap}% cap`;
            this.finish(key, live, {status: 'skipped', startedAt: null, endedAt: clock.now(), reason, weekBefore});
            return;
        }

        let cwd = schedule.projectPath;
        let folder = schedule.folder;
        let worktree: string | null = null;
        if (schedule.worktree) {
            const made = await this.makeWorktree(schedule);
            if ('error' in made) {
                this.finish(key, live, {status: 'failed', reason: made.error, endedAt: clock.now(), weekBefore});
                return;
            }
            if (made.path) {
                cwd = made.path;
                folder = encodeProjectPath(made.path);
                worktree = made.path;
            }
        }

        const sessionId = ids.newId();
        // Before the seed: a file with a value the CLI must not be handed fails here, leaving nothing behind.
        const args = buildScheduleArgs(sessionId, schedule);
        transcripts.seedSession(folder, sessionId, [
            {
                type: 'user',
                parentUuid: null,
                uuid: ids.newId(),
                sessionId,
                cwd,
                slug: schedule.slug,
                timestamp: new Date(clock.now()).toISOString(),
                message: {role: 'user', content: 'Scheduled Task: ' + schedule.prompt},
            },
        ]);
        this.change(live.runId, {sessionId, worktree, weekBefore});

        live.command = runner.run(args, cwd, schedule.name, (ending) => {
            this.ended(schedule, live, ending).catch((err: Error) =>
                log.error(`[schedule] could not record how ${schedule.name} ended:`, err.message),
            );
        });
        if (schedule.limitMinutes !== null && this.live.get(key) === live) {
            live.limitTimer = timers.setTimeout(() => {
                log.warn(`[schedule] ${schedule.name} reached its ${schedule.limitMinutes} min limit; stopping it`);
                live.limitHit = true;
                live.command?.kill('SIGTERM');
                live.killTimer = timers.setTimeout(() => live.command?.kill('SIGKILL'), KILL_GRACE_MS);
            }, schedule.limitMinutes * 60_000);
        }
    }

    /** The process ended: read the week again, and record how it went. */
    private async ended(schedule: Schedule, live: LiveRun, ending: CommandEnding): Promise<void> {
        const {clock, timers} = this.deps;
        timers.clearTimeout(live.limitTimer);
        timers.clearTimeout(live.killTimer);
        const outcome = runOutcome({...ending, limitHit: live.limitHit, limitMinutes: schedule.limitMinutes});
        const weekAfter = await this.week();
        const run = this.runs.get(live.runId);
        this.finish(schedule.filePath, live, {
            status: outcome.status,
            // A caught-up run keeps why it ran late unless it has a failure to tell.
            reason: outcome.reason ?? run?.reason ?? null,
            report: outcome.report,
            seen: outcome.seen,
            endedAt: clock.now(),
            weekAfter,
            ...(outcome.sessionId ? {sessionId: outcome.sessionId} : {}),
        });
        const sessionId = this.runs.get(live.runId)?.sessionId;
        if (outcome.status === 'done' && outcome.seen && sessionId) this.deps.archive?.(sessionId);
    }

    private finish(key: string, live: LiveRun, change: Partial<Omit<ScheduleRun, 'id' | 'scheduleKey'>>): void {
        if (this.live.get(key) === live) this.live.delete(key);
        this.change(live.runId, change);
    }

    /**
     * A fresh worktree off the default branch for one run; `path: null` when
     * the project is not in a git repository, so the run works in it as before.
     */
    private async makeWorktree(schedule: Schedule): Promise<{path: string | null} | {error: string}> {
        const {git, clock} = this.deps;
        if (!git) return {path: null};
        const root = schedule.projectPath;
        if (!(await git.worktreeRoot(root))) return {path: null};

        const {path, branch} = scheduleWorktree(root, schedule.slug, clock.now());
        const defaultBranch = await git.defaultBranch(root);
        // A failed fetch still leaves the last one fetched to start from.
        await git.fetchBranch(root, defaultBranch);
        let start: string | null = null;
        if (await git.commitSha(root, 'origin/' + defaultBranch)) start = 'origin/' + defaultBranch;
        else if (await git.commitSha(root, defaultBranch)) start = defaultBranch;
        if (!start) return {error: `its worktree could not be made: no ${defaultBranch} branch to start from`};

        const added = await git.addWorktree(root, path, branch, start);
        if (!added.ok) return {error: `its worktree could not be made: ${added.reason}`};
        return {path};
    }

    /**
     * The week's all-models usage in percent, or null when unknown: no usage
     * port, an error, or a rate limit. Unknown never stops a run.
     */
    private week(): Promise<number | null> {
        const {usage, clock} = this.deps;
        if (!usage) return Promise.resolve(null);
        const now = clock.now();
        if (this.weekReading && now - this.weekReading.at < WEEK_READING_MS) return this.weekReading.value;
        const value = usage.fetch().then(
            (read) => (read._error || read._rateLimited || typeof read.weekAll !== 'number' ? null : read.weekAll),
            () => null,
        );
        this.weekReading = {at: now, value};
        return value;
    }

    private blankRun(
        id: string,
        schedule: Schedule,
        trigger: RunTrigger,
        dueAt: number | null,
        now: number,
    ): ScheduleRun {
        return {
            id,
            scheduleKey: schedule.filePath,
            sessionId: null,
            trigger,
            dueAt,
            startedAt: null,
            endedAt: null,
            status: 'skipped',
            reason: null,
            promptVersion: this.runs.versionFor(schedule.filePath, schedule.prompt, now, EDITED_OUTSIDE),
            report: null,
            weekBefore: null,
            weekAfter: null,
            worktree: null,
            seen: false,
        };
    }

    private record(run: ScheduleRun): void {
        this.runs.add(run);
        this.changed();
    }

    private change(id: string, change: Partial<Omit<ScheduleRun, 'id' | 'scheduleKey'>>): void {
        this.runs.update(id, change);
        this.changed();
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (err) {
                this.deps.log.error('[schedule] a change listener failed:', (err as Error).message);
            }
        }
    }

    // ── Finding the files ──

    /** The schedules the tick may run: here, on, and turned on. */
    private runnable(): Schedule[] {
        return this.files(true).filter((schedule) => schedule.enabled && !this.isNew(schedule.filePath));
    }

    private isNew(key: string): boolean {
        return this.turnOnFirst && this.runs.versionsOf(key).length === 0;
    }

    private entry(schedule: Schedule): ScheduleEntry {
        return {
            key: schedule.filePath,
            settings: scheduleSettings(schedule),
            runsOn: this.runsOn(schedule.projectPath),
            isNew: this.isNew(schedule.filePath),
        };
    }

    private runsOn(projectPath: string): ScheduleRunsOn {
        const {runsHere, vmHostOf} = this.deps;
        if (!runsHere || runsHere(projectPath)) return {kind: 'mac'};
        return {kind: 'vm', host: vmHostOf?.(projectPath) ?? 'its VM'};
    }

    /**
     * Each schedule file once, however many transcript folders its project
     * has: a worktree's folder resolves to its repository too. The folder kept
     * is the one Claude names after the project, where `claude --resume` in
     * the project looks for the seeded session.
     */
    private files(onlyHere: boolean): Schedule[] {
        const byFile = new Map<string, Schedule>();
        for (const target of this.targets(onlyHere)) {
            for (const schedule of this.schedulesIn(target)) {
                const seen = byFile.get(schedule.filePath);
                if (!seen || schedule.folder === encodeProjectPath(schedule.projectPath)) {
                    byFile.set(schedule.filePath, schedule);
                }
            }
        }
        return [...byFile.values()];
    }

    /**
     * The projects to look in: every transcript folder's project, then the
     * extra projects, each kept only when it runs here (`onlyHere`).
     *
     * Without `extraProjects` this is exactly the folder list as it always
     * was, one target per folder (`runsHere` only filters it). With it (on a
     * VM's agent), each project path is one target: a worktree's transcript folder resolves to its
     * repository, and scanning that twice would run its schedules twice. The
     * folder kept is the one Claude names after the project, since that is
     * where `claude --resume` in the project looks for the seeded session.
     */
    private targets(onlyHere: boolean): ScanTarget[] {
        const {transcripts, repository, runsHere, extraProjects} = this.deps;
        const perProject = extraProjects !== undefined;
        const targets: ScanTarget[] = [];
        const byProject = new Map<string, ScanTarget>();
        const add = (target: ScanTarget): void => {
            if (onlyHere && runsHere && !runsHere(target.projectPath)) return;
            if (!perProject) {
                targets.push(target);
                return;
            }
            const seen = byProject.get(target.projectPath);
            if (!seen) {
                byProject.set(target.projectPath, target);
                targets.push(target);
            } else if (target.folder === encodeProjectPath(target.projectPath)) {
                seen.folder = target.folder;
            }
        };

        let folders: string[] = [];
        try {
            folders = transcripts.listFolders();
        } catch {
            // No transcripts at all: the extra projects can still be scanned.
            if (!perProject) return targets;
        }

        const folderMeta = repository.getAllFolderMeta();
        for (const folder of folders) {
            const projectPath = folderMeta.get(folder)?.projectPath || transcripts.resolveProjectPath(folder);
            if (projectPath) add({projectPath, folder});
        }
        for (const projectPath of extraProjects?.() ?? []) {
            add({projectPath, folder: encodeProjectPath(projectPath)});
        }
        return targets;
    }

    /** The schedules in one project's `.claude/commands`, on or off. */
    private schedulesIn({projectPath, folder}: ScanTarget): Schedule[] {
        const {fs, log} = this.deps;
        const schedules: Schedule[] = [];
        const commandsDir = fs.join(projectPath, ...SCHEDULE_COMMANDS_SUBPATH);
        if (!fs.exists(commandsDir)) return schedules;

        let entries;
        try {
            entries = fs.readDir(commandsDir);
        } catch {
            return schedules;
        }

        for (const entry of entries) {
            if (!entry.isFile || !isScheduleFileName(entry.name)) continue;
            const filePath = fs.join(commandsDir, entry.name);
            try {
                const schedule = parseSchedule(fs.readText(filePath), {
                    file: entry.name,
                    filePath,
                    projectPath,
                    folder,
                });
                if (schedule) schedules.push(schedule);
            } catch (err) {
                log.warn(`[schedule] could not parse ${entry.name}:`, (err as Error).message);
            }
        }
        return schedules;
    }

    // ── The schedule creator ──

    /** Install the creator command, if the user does not already have it. */
    public ensureCreatorCommand(): void {
        const {fs, log} = this.deps;
        try {
            const commandPath = this.creatorCommandPath();
            // An install from before the Schedule manager still points at the
            // brain tab and its schedules ran unseen: it is replaced. Any other
            // copy may be the user's own edit and is left alone.
            if (fs.exists(commandPath) && !fs.readText(commandPath).includes('brain tab')) return;
            fs.makeDir(this.deps.commandsDir);
            fs.writeText(commandPath, SCHEDULE_CREATOR_TEMPLATE);
        } catch (err) {
            log.error('[schedule] could not install the creator command:', (err as Error).message);
        }
    }

    private creatorCommandPath(): string {
        return this.deps.fs.join(this.deps.commandsDir, 'create-switchboard-schedule.md');
    }
}
