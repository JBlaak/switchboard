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
import { cronMatches } from '../../domain/schedule/cron';
import {
  SCHEDULE_CREATOR_TEMPLATE, SCHEDULE_WELCOME_MESSAGE,
} from '../../domain/schedule/creator-template';
import {
  buildScheduleArgs, isScheduleFileName, parseSchedule, parseScheduleForManualRun,
  SCHEDULE_COMMANDS_SUBPATH, scheduleTaskKey,
} from '../../domain/schedule/schedule';
import { encodeProjectPath } from '../../domain/project/project-path';
import type { Schedule, ScheduleLocation } from '../../domain/schedule/schedule';
import type { CommandRunner } from '../ports/claude-cli';
import type { Clock, Timers } from '../ports/clock';
import type { FileSystem } from '../ports/file-system';
import type { IdGenerator } from '../ports/ids';
import type { Logger } from '../ports/logger';
import type { SessionRepository } from '../ports/session-repository';
import type { TranscriptStore } from '../ports/transcript-store';

/** The cron loop's resolution. */
const TICK_MS = 60 * 1000;

export interface ScheduleServiceDeps {
  fs: FileSystem;
  transcripts: TranscriptStore;
  repository: SessionRepository;
  runner: CommandRunner;
  ids: IdGenerator;
  clock: Clock;
  timers: Timers;
  log: Logger;
  /** `~/.claude/commands` — where the creator command is installed. */
  commandsDir: string;
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
  scan(): Schedule[] {
    const { fs, transcripts, repository, log } = this.deps;
    const schedules: Schedule[] = [];

    let folders: string[];
    try {
      folders = transcripts.listFolders();
    } catch {
      return schedules;
    }

    const folderMeta = repository.getAllFolderMeta();

    for (const folder of folders) {
      const projectPath = folderMeta.get(folder)?.projectPath
        || transcripts.resolveProjectPath(folder);
      if (!projectPath) continue;

      const commandsDir = fs.join(projectPath, ...SCHEDULE_COMMANDS_SUBPATH);
      if (!fs.exists(commandsDir)) continue;

      let entries;
      try {
        entries = fs.readDir(commandsDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile || !isScheduleFileName(entry.name)) continue;
        const filePath = fs.join(commandsDir, entry.name);
        try {
          const schedule = parseSchedule(fs.readText(filePath), {
            file: entry.name, filePath, projectPath, folder,
          });
          if (schedule) schedules.push(schedule);
        } catch (err) {
          log.warn(`[schedule] could not parse ${entry.name}:`, (err as Error).message);
        }
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
  start(): () => void {
    const { timers, clock, log } = this.deps;
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
          this.#dispatch(schedule, () => inFlight.delete(key));
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

  /** Run one schedule immediately, ignoring its cron and its enabled flag. */
  runNow(filePath: string): { ok: true; sessionId: string } | { ok: false; error: string } {
    const { fs, log } = this.deps;
    try {
      const schedule = parseScheduleForManualRun(fs.readText(filePath), this.#locate(filePath));
      if (!schedule) return { ok: false, error: 'No prompt in schedule file' };

      const sessionId = this.#dispatch(schedule, () => {});
      log.info(`[schedule] manual run triggered: ${schedule.name} (session ${sessionId})`);
      return { ok: true, sessionId };
    } catch (err) {
      log.error('[schedule] could not run schedule:', (err as Error).message);
      return { ok: false, error: (err as Error).message };
    }
  }

  // ── The schedule creator ──

  /** Install the creator command, if the user does not already have it. */
  ensureCreatorCommand(): void {
    const { fs, log } = this.deps;
    try {
      const commandPath = this.#creatorCommandPath();
      if (fs.exists(commandPath)) return;
      fs.makeDir(this.deps.commandsDir);
      fs.writeText(commandPath, SCHEDULE_CREATOR_TEMPLATE);
    } catch (err) {
      log.error('[schedule] could not install the creator command:', (err as Error).message);
    }
  }

  readCreatorCommand(): string | null {
    const { fs, log } = this.deps;
    try {
      this.ensureCreatorCommand();
      return fs.readText(this.#creatorCommandPath());
    } catch (err) {
      log.error('[schedule] could not read the creator command:', (err as Error).message);
      return null;
    }
  }

  /**
   * Seed a session for the schedule creator to open into.
   *
   * The transcript is written before the CLI runs so the session already has a
   * first message explaining itself — the alternative is an empty terminal and
   * a user who has to guess what to type.
   */
  createCreatorSession(projectPath: string): { sessionId: string; systemPrompt: string } | null {
    const { transcripts, ids, clock, log } = this.deps;
    try {
      const systemPrompt = this.readCreatorCommand();
      if (systemPrompt === null) return null;

      const sessionId = ids.newId();
      const messageId = ids.newId();
      const timestamp = new Date(clock.now()).toISOString();
      const folder = encodeProjectPath(projectPath);

      transcripts.seedSession(folder, sessionId, [
        {
          type: 'file-history-snapshot',
          messageId,
          snapshot: { messageId, trackedFileBackups: {}, timestamp },
          isSnapshotUpdate: false,
        },
        {
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd: projectPath,
          sessionId,
          version: '1.0.0',
          gitBranch: 'main',
          slug: 'create-schedule',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: SCHEDULE_WELCOME_MESSAGE }] },
          uuid: messageId,
          timestamp,
        },
      ]);

      log.info(`[schedule] pre-created schedule session ${sessionId} for ${projectPath}`);
      return { sessionId, systemPrompt };
    } catch (err) {
      log.error('[schedule] could not create a schedule session:', (err as Error).message);
      return null;
    }
  }

  /** Seed a session for one run and hand it to the runner. */
  #dispatch(schedule: Schedule, onDone: () => void): string {
    const { transcripts, ids, clock, runner } = this.deps;

    const sessionId = ids.newId();
    transcripts.seedSession(schedule.folder, sessionId, [{
      type: 'user',
      parentUuid: null,
      uuid: ids.newId(),
      sessionId,
      cwd: schedule.projectPath,
      slug: schedule.slug,
      timestamp: new Date(clock.now()).toISOString(),
      message: { role: 'user', content: 'Scheduled Task: ' + schedule.prompt },
    }]);

    runner.run(buildScheduleArgs(sessionId, schedule), schedule.projectPath, schedule.name, onDone);
    return sessionId;
  }

  /**
   * Work out which project a schedule file belongs to from its own path.
   *
   * `<project>/.claude/commands/schedule-x.md` — three levels up is the project.
   */
  #locate(filePath: string): ScheduleLocation {
    const { fs } = this.deps;
    const commandsDir = fs.dirname(filePath);
    const projectPath = fs.dirname(fs.dirname(commandsDir));
    return {
      file: fs.basename(filePath),
      filePath,
      projectPath,
      folder: encodeProjectPath(projectPath),
    };
  }

  #creatorCommandPath(): string {
    return this.deps.fs.join(this.deps.commandsDir, 'create-switchboard-schedule.md');
  }
}
