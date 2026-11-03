/**
 * Scheduled tasks: finding them, running them, and helping the user write one.
 *
 * The schedules themselves live in the projects, not in Switchboard — a
 * `schedule-*.md` under `.claude/commands/`, which makes each one both a cron
 * job and a slash command. So there is nothing to store and nothing to migrate:
 * the tick rescans, which also means a file edited by hand takes effect on the
 * next minute.
 *
 * Every run resumes a freshly seeded session rather than starting a bare one,
 * which is what groups a task's runs under a single slug in the sidebar.
 */
import {cronMatches} from '../../domain/schedule/cron';
import {encodeProjectPath} from '../../domain/project/project-path';
import {SCHEDULE_CREATOR_TEMPLATE} from '../../domain/schedule/creator-template';
import {
    buildScheduleArgs,
    isScheduleFileName,
    parseSchedule,
    SCHEDULE_COMMANDS_SUBPATH,
    scheduleTaskKey,
} from '../../domain/schedule/schedule';
import type {Schedule} from '../../domain/schedule/schedule';
import type {CommandRunner} from '../ports/claude-cli';
import type {Clock, Timers} from '../ports/clock';
import type {FileSystem} from '../ports/file-system';
import type {IdGenerator} from '../ports/ids';
import type {Logger} from '../ports/logger';
import type {SessionRepository} from '../ports/session-repository';
import type {TranscriptStore} from '../ports/transcript-store';

/** The cron loop's resolution. */
const TICK_MS = 60 * 1000;

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
}

/** One project to look for schedules in, and the transcript folder its runs are seeded in. */
interface ScanTarget {
    projectPath: string;
    folder: string;
}

export class ScheduleService {
    constructor(private readonly deps: ScheduleServiceDeps) {}

    /**
     * Every enabled schedule across every project.
     *
     * The folder → project-path mapping comes from the index rather than by
     * re-reading a transcript per project: this runs every 60 seconds, and
     * parsing 4KB of every project's history each time was the whole cost of the
     * feature.
     */
    public scan(): Schedule[] {
        const schedules: Schedule[] = [];
        for (const target of this.targets()) schedules.push(...this.schedulesIn(target));
        return schedules;
    }

    /**
     * The projects to look in: every transcript folder's project, then the
     * extra projects, each kept only when it runs here.
     *
     * Without `extraProjects` this is exactly the folder list as it always
     * was, one target per folder (`runsHere` only filters it). With it (on a
     * VM's agent), each project path is one target: a worktree's transcript folder resolves to its
     * repository, and scanning that twice would run its schedules twice. The
     * folder kept is the one Claude names after the project, since that is
     * where `claude --resume` in the project looks for the seeded session.
     */
    private targets(): ScanTarget[] {
        const {transcripts, repository, runsHere, extraProjects} = this.deps;
        const perProject = extraProjects !== undefined;
        const targets: ScanTarget[] = [];
        const byProject = new Map<string, ScanTarget>();
        const add = (target: ScanTarget): void => {
            if (runsHere && !runsHere(target.projectPath)) return;
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

    /** The enabled schedules in one project's `.claude/commands`. */
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

    /**
     * Start the cron loop, and answer with the function that stops it.
     *
     * The first tick is aligned to the next minute boundary so a schedule set for
     * `09:00` runs at `09:00:00`-ish rather than at whatever second the app
     * happened to launch on.
     */
    public start(): () => void {
        const {timers, clock, log} = this.deps;
        let running = true;
        const inFlight = new Set<string>();
        let interval: unknown = null;

        const tick = (): void => {
            if (!running) return;
            const now = new Date(clock.now());
            for (const schedule of this.scan()) {
                if (!cronMatches(schedule.cron, now)) continue;

                const key = scheduleTaskKey(schedule);
                if (inFlight.has(key)) {
                    log.info(`[schedule] skipping ${schedule.name} — still running from the previous trigger`);
                    continue;
                }

                log.info(`[schedule] triggering: ${schedule.name} (${schedule.cron})`);
                try {
                    inFlight.add(key);
                    this.dispatch(schedule, () => inFlight.delete(key));
                } catch (err) {
                    inFlight.delete(key);
                    log.error(`[schedule] could not run ${schedule.name}:`, (err as Error).message);
                }
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

    // ── The schedule creator ──

    /** Install the creator command, if the user does not already have it. */
    public ensureCreatorCommand(): void {
        const {fs, log} = this.deps;
        try {
            const commandPath = this.creatorCommandPath();
            if (fs.exists(commandPath)) return;
            fs.makeDir(this.deps.commandsDir);
            fs.writeText(commandPath, SCHEDULE_CREATOR_TEMPLATE);
        } catch (err) {
            log.error('[schedule] could not install the creator command:', (err as Error).message);
        }
    }

    /** Seed a session for one run and hand it to the runner. */
    private dispatch(schedule: Schedule, onDone: () => void): void {
        const {transcripts, ids, clock, runner} = this.deps;

        const sessionId = ids.newId();
        transcripts.seedSession(schedule.folder, sessionId, [
            {
                type: 'user',
                parentUuid: null,
                uuid: ids.newId(),
                sessionId,
                cwd: schedule.projectPath,
                slug: schedule.slug,
                timestamp: new Date(clock.now()).toISOString(),
                message: {role: 'user', content: 'Scheduled Task: ' + schedule.prompt},
            },
        ]);

        runner.run(buildScheduleArgs(sessionId, schedule), schedule.projectPath, schedule.name, onDone);
    }

    private creatorCommandPath(): string {
        return this.deps.fs.join(this.deps.commandsDir, 'create-switchboard-schedule.md');
    }
}
