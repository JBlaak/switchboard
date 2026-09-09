/**
 * Where the real implementations are chosen.
 *
 * The single place in the app that knows both an interface and the thing behind
 * it. Everything above reads a port; everything below is an adapter; this
 * function is the seam, and swapping SQLite for something else, or node-pty for
 * a fake, is an edit here and nowhere else.
 *
 * Read it top to bottom: primitives, then stores, then the session machinery,
 * then the feature services. The one place the order is not a straight line is
 * the session lifecycle and the SSH supervisor, which need each other — see
 * `attach` below.
 */
import log from 'electron-log';
import { app } from 'electron';
import path from 'node:path';

import { systemClock } from '../application/ports/clock';
import { uuidGenerator } from '../application/ports/ids';
import { AgentFileService } from '../application/services/agent-file-service';
import { BrowseService } from '../application/services/browse-service';
import { GitService } from '../application/services/git-service';
import { PlanService } from '../application/services/plan-service';
import { ProjectListService } from '../application/services/project-list-service';
import { RemoteConnectionSupervisor } from '../application/services/remote-connection-supervisor';
import { ScheduleService } from '../application/services/schedule-service';
import { SessionIndex } from '../application/services/session-index';
import { SessionLauncher } from '../application/services/session-launcher';
import { SessionLifecycle } from '../application/services/session-lifecycle';
import { SessionTransitionDetector } from '../application/services/session-transition-detector';
import { SettingsService } from '../application/services/settings-service';
import { SessionRegistry } from '../application/model/session-registry';

import { ClaudeCliStatsService } from '../infrastructure/claude-cli/stats-service';
import { ClaudeCommandRunner } from '../infrastructure/claude-cli/command-runner';
import { OAuthUsageService } from '../infrastructure/claude-cli/usage-service';
import { ElectronDialogService, ElectronSystemGateway } from '../infrastructure/electron/desktop';
import { ElectronRendererGateway } from '../infrastructure/electron/renderer-gateway';
import { ElectronUpdater } from '../infrastructure/electron/updater';
import { FileTranscriptStore } from '../infrastructure/fs/transcript-store';
import { FileWatchRegistry } from '../infrastructure/fs/file-watch-registry';
import { NodeFileSystem } from '../infrastructure/fs/node-file-system';
import { ProjectsWatcher } from '../infrastructure/fs/projects-watcher';
import { McpIdeBridge } from '../infrastructure/mcp/ide-bridge';
import { NodeProcessRunner } from '../infrastructure/process/node-process-runner';
import { NodePtyGateway } from '../infrastructure/pty/node-pty-gateway';
import { SystemShellProfileProvider } from '../infrastructure/shell/shell-discovery';
import { WorkerProjectScanner } from '../infrastructure/worker/worker-project-scanner';
import { SqliteSearchIndex } from '../infrastructure/sqlite/search-index';
import { SqliteSessionRepository } from '../infrastructure/sqlite/session-repository';
import { SqliteSettingsStore } from '../infrastructure/sqlite/settings-store';
import { openDatabase } from '../infrastructure/sqlite/database';
import { resolveClaudePaths } from '../infrastructure/fs/claude-paths';
import { systemTimers } from '../infrastructure/system/timers';

import type { BrowserWindow } from 'electron';
import type { SwitchboardDatabase } from '../infrastructure/sqlite/database';

/** Everything the IPC layer and the app lifecycle reach for. */
export interface Container {
  readonly log: typeof log;
  readonly paths: ReturnType<typeof resolveClaudePaths>;

  readonly settings: SettingsService;
  readonly repository: SqliteSessionRepository;
  readonly searchIndex: SqliteSearchIndex;
  readonly transcripts: FileTranscriptStore;
  readonly fs: NodeFileSystem;
  readonly processes: NodeProcessRunner;

  readonly registry: SessionRegistry;
  readonly terminals: NodePtyGateway;
  readonly shells: SystemShellProfileProvider;
  readonly ideBridge: McpIdeBridge;
  readonly lifecycle: SessionLifecycle;
  readonly remote: RemoteConnectionSupervisor;
  readonly launcher: SessionLauncher;
  readonly transitions: SessionTransitionDetector;

  readonly sessionIndex: SessionIndex;
  readonly projects: ProjectListService;
  readonly plans: PlanService;
  readonly agentFiles: AgentFileService;
  readonly git: GitService;
  readonly browse: BrowseService;
  readonly stats: ClaudeCliStatsService;
  readonly usage: OAuthUsageService;
  readonly schedules: ScheduleService;

  readonly renderer: ElectronRendererGateway;
  readonly updater: ElectronUpdater;
  readonly dialogs: ElectronDialogService;
  readonly system: ElectronSystemGateway;
  readonly fileWatches: FileWatchRegistry;
  readonly projectsWatcher: ProjectsWatcher;

  /** The window, once one exists. Set by the app lifecycle. */
  setWindow(window: BrowserWindow | null): void;
  getWindow(): BrowserWindow | null;

  close(): void;
}

/** The directory the built bundles live in — `app/` beside this module. */
function appDir(): string {
  return __dirname;
}

export function buildContainer(): Container {
  // ── Primitives ──
  const paths = resolveClaudePaths();
  const clock = systemClock;
  const timers = systemTimers;
  const ids = uuidGenerator;
  const fs = new NodeFileSystem();

  let window: BrowserWindow | null = null;
  const getWindow = (): BrowserWindow | null => window;
  const renderer = new ElectronRendererGateway(getWindow);

  // ── Stores ──
  const database: SwitchboardDatabase = openDatabase();
  const repository = new SqliteSessionRepository(database.db);
  const searchIndex = new SqliteSearchIndex(database.db, database.searchFtsRecreated);
  const settings = new SettingsService(new SqliteSettingsStore(database.db));
  const transcripts = new FileTranscriptStore(fs, paths.projectsDir);

  // ── Session machinery ──
  const registry = new SessionRegistry();
  const terminals = new NodePtyGateway();
  const processes = new NodeProcessRunner({ baseEnv: terminals.baseEnv });
  const shells = new SystemShellProfileProvider();
  const ideBridge = new McpIdeBridge({ renderer, log, ideDir: paths.ideDir });

  // The lifecycle needs the supervisor to interpret a remote session's exit;
  // the supervisor needs the lifecycle to wire the PTY a reconnect produces.
  // Constructed in that order and closed with `attach`.
  const remote = new RemoteConnectionSupervisor({
    registry, terminals, renderer, timers, clock, log,
    isWindows: shells.isWindows,
    homeDir: paths.homeDir,
  });
  const lifecycle = new SessionLifecycle({
    registry, terminals, renderer, ideBridge, remote, timers, log,
  });
  remote.attach(lifecycle);

  const launcher = new SessionLauncher({
    registry, terminals, shells, transcripts, settings, ideBridge,
    lifecycle, remote, renderer, clock, timers, log,
    homeDir: paths.homeDir,
    fileExists: (target) => fs.exists(target),
  });

  const transitions = new SessionTransitionDetector({
    registry, transcripts, renderer, ideBridge, clock, log,
  });

  // ── Indexing ──
  const scanner = new WorkerProjectScanner({
    workerPath: path.join(appDir(), 'workers', 'scan-projects.js'),
    projectsDir: paths.projectsDir,
    log,
  });
  const sessionIndex = new SessionIndex({
    repository, searchIndex, transcripts, scanner, renderer, timers, log,
  });

  const projects = new ProjectListService({ repository, transcripts, settings, registry });

  // ── Feature services ──
  const usage = new OAuthUsageService(log);
  const shellProfileId = (): string => settings.shellProfileId(null);

  const stats = new ClaudeCliStatsService({
    fs, terminals, shells, usage, timers, log,
    statsCachePath: paths.statsCachePath,
    homeDir: paths.homeDir,
    shellProfileId,
  });

  const plans = new PlanService({ fs, searchIndex, log, plansDir: paths.plansDir });

  const agentFiles = new AgentFileService({
    fs, transcripts, settings, searchIndex, log,
    claudeDir: paths.claudeDir,
    projectsDir: paths.projectsDir,
  });

  const git = new GitService({ runner: processes, log });
  const browse = new BrowseService({ fs, runner: processes, log });

  const schedules = new ScheduleService({
    fs, transcripts, repository, ids, clock, timers, log,
    commandsDir: paths.commandsDir,
    runner: new ClaudeCommandRunner({ shells, terminals, log, shellProfileId }),
  });

  // ── Host ──
  const updater = new ElectronUpdater({
    log,
    onEvent: (type, data) => renderer.updaterEvent(type, data),
  });
  const dialogs = new ElectronDialogService(getWindow);
  const system = new ElectronSystemGateway(log);

  const fileWatches = new FileWatchRegistry({
    fs, timers,
    onChanged: (filePath) => renderer.fileChanged(filePath),
  });

  // Every write the CLI makes to a transcript arrives here: re-index the folder,
  // check whether a session forked, and refresh the sidebar once per burst.
  const projectsWatcher = new ProjectsWatcher({
    fs, timers, log,
    projectsDir: paths.projectsDir,
    onFoldersChanged: (folders) => {
      for (const folder of folders) {
        if (transcripts.folderExists(folder)) {
          transitions.detect(folder);
          sessionIndex.refreshFolder(folder);
        } else {
          sessionIndex.forgetFolder(folder);
        }
      }
      renderer.projectsChanged();
    },
  });

  return {
    log, paths,
    settings, repository, searchIndex, transcripts, fs, processes,
    registry, terminals, shells, ideBridge, lifecycle, remote, launcher, transitions,
    sessionIndex, projects, plans, agentFiles, git, browse, stats, usage, schedules,
    renderer, updater, dialogs, system, fileWatches, projectsWatcher,
    setWindow: (next) => { window = next; },
    getWindow,
    close: () => {
      projectsWatcher.stop();
      fileWatches.closeAll();
      ideBridge.stopAll();
      database.close();
    },
  };
}

/** Where the packaged app keeps its data, isolated per instance when asked. */
export function isolateUserDataIfRequested(): void {
  // SWITCHBOARD_DATA_DIR isolates a dev/test instance from the installed app:
  // the database goes under it, and pointing userData there gives the instance
  // its own single-instance lock, so both can run side by side.
  if (!process.env.SWITCHBOARD_DATA_DIR) return;
  app.setPath('userData', path.resolve(process.env.SWITCHBOARD_DATA_DIR, 'electron'));
}
