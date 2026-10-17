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
import { QuestionService } from '../application/services/question-service';
import { ProjectListService } from '../application/services/project-list-service';
import { RemoteConnectionSupervisor } from '../application/services/remote-connection-supervisor';
import { ScheduleService } from '../application/services/schedule-service';
import { SessionIndex } from '../application/services/session-index';
import { SessionLauncher } from '../application/services/session-launcher';
import { SessionLifecycle } from '../application/services/session-lifecycle';
import { SessionTransitionDetector } from '../application/services/session-transition-detector';
import { SessionWorkService } from '../application/services/session-work-service';
import { SessionActionService } from '../application/services/session-action-service';
import { SettingsService } from '../application/services/settings-service';
import { UpdateService } from '../application/services/update-service';
import { WeatherService } from '../application/services/weather-service';
import { SessionRegistry } from '../application/model/session-registry';

import { ClaudeCommandRunner } from '../infrastructure/claude-cli/command-runner';
import { OAuthUsageService } from '../infrastructure/claude-cli/usage-service';
import {
  ElectronAppearanceGateway, ElectronDialogService, ElectronSystemGateway,
} from '../infrastructure/electron/desktop';
import { ElectronRendererGateway } from '../infrastructure/electron/renderer-gateway';
import { FileTranscriptStore } from '../infrastructure/fs/transcript-store';
import { NodeFileSystem } from '../infrastructure/fs/node-file-system';
import { ProjectsWatcher } from '../infrastructure/fs/projects-watcher';
import { NodePtyGateway } from '../infrastructure/pty/node-pty-gateway';
import { PtySessionPrompter } from '../infrastructure/pty/session-prompter';
import { SystemShellProfileProvider } from '../infrastructure/shell/shell-discovery';
import { WorkerProjectScanner } from '../infrastructure/worker/worker-project-scanner';
import { SqliteSearchIndex } from '../infrastructure/sqlite/search-index';
import { SqliteSessionRepository } from '../infrastructure/sqlite/session-repository';
import { SqliteSettingsStore } from '../infrastructure/sqlite/settings-store';
import { SqliteActivityStore } from '../infrastructure/sqlite/activity-store';
import { openDatabase } from '../infrastructure/sqlite/database';
import { resolveClaudePaths } from '../infrastructure/fs/claude-paths';
import { systemTimers } from '../infrastructure/system/timers';
import { OpenMeteoWeatherSource } from '../infrastructure/weather/open-meteo';
import { PmsetSleepControl } from '../infrastructure/system/pmset-sleep-control';
import { BundleInstaller } from '../infrastructure/system/bundle-installer';
import { GitHubReleaseFeed } from '../infrastructure/github/github-release-feed';
import { GitCliRemotes } from '../infrastructure/git/git-cli-remotes';
import { GitCliWorkspace } from '../infrastructure/git/git-cli-workspace';
import { GhCli, defaultGhRunner } from '../infrastructure/github/gh-cli';
import { loginShellEnv } from '../infrastructure/shell/login-shell-env';
import { encodeProjectPath } from '../domain/project/project-path';
import { isRemoteProjectPath } from '../domain/project/remote-target';
import { QuestionHookServer } from '../infrastructure/http/question-hook-server';

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

  readonly registry: SessionRegistry;
  readonly terminals: NodePtyGateway;
  readonly shells: SystemShellProfileProvider;
  readonly lifecycle: SessionLifecycle;
  readonly remote: RemoteConnectionSupervisor;
  readonly launcher: SessionLauncher;
  readonly transitions: SessionTransitionDetector;
  readonly questions: QuestionService;
  readonly questionHook: QuestionHookServer;

  readonly sessionIndex: SessionIndex;
  readonly projects: ProjectListService;
  readonly usage: OAuthUsageService;
  readonly schedules: ScheduleService;
  readonly weather: WeatherService;
  readonly updates: UpdateService;
  readonly sessionWork: SessionWorkService;
  readonly sessionActions: SessionActionService;

  readonly renderer: ElectronRendererGateway;
  readonly dialogs: ElectronDialogService;
  readonly system: ElectronSystemGateway;
  readonly appearance: ElectronAppearanceGateway;
  readonly sleep: PmsetSleepControl;
  readonly git: GitCliRemotes;
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
  const shells = new SystemShellProfileProvider();
  // Types the Session work actions into a session, and hears it go idle from the lifecycle.
  const prompter = new PtySessionPrompter({ sessions: registry, timers, log });

  // The lifecycle needs the supervisor to interpret a remote session's exit;
  // the supervisor needs the lifecycle to wire the PTY a reconnect produces.
  // Constructed in that order and closed with `attach`.
  const remote = new RemoteConnectionSupervisor({
    registry, terminals, renderer, timers, clock, log,
    homeDir: paths.homeDir,
  });
  const lifecycle = new SessionLifecycle({
    registry, terminals, renderer, remote, timers, log,
    cliState: prompter,
  });
  remote.attach(lifecycle);

  // The server and the service need each other: the service bakes the server's
  // address into each launch, the server hands each request to the service.
  // The server only calls `receive` once a request arrives, long after both exist.
  const questionHook = new QuestionHookServer({
    receiver: { receive: (...args) => questions.receive(...args) },
    log,
  });
  const questions = new QuestionService({
    registry, renderer, clock, log, endpoint: questionHook,
  });

  const launcher = new SessionLauncher({
    registry, terminals, shells, transcripts, settings,
    lifecycle, remote, renderer, questions, clock, timers, log,
    fileExists: (target) => fs.exists(target),
  });

  const transitions = new SessionTransitionDetector({
    registry, transcripts, renderer, clock, log,
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
  const weather = new WeatherService({
    source: new OpenMeteoWeatherSource(clock, log), settings, clock, log,
  });
  const updates = new UpdateService({
    feed: new GitHubReleaseFeed({ owner: 'JBlaak', name: 'switchboard' }),
    installer: new BundleInstaller(log),
    renderer, timers, log,
    currentVersion: app.getVersion(),
    arch: process.arch,
  });
  const shellProfileId = (): string => settings.shellProfileId(null);

  const schedules = new ScheduleService({
    fs, transcripts, repository, ids, clock, timers, log,
    commandsDir: paths.commandsDir,
    runner: new ClaudeCommandRunner({ shells, terminals, log, shellProfileId }),
  });

  // ── Host ──
  const dialogs = new ElectronDialogService(getWindow);
  const system = new ElectronSystemGateway(log);
  const appearance = new ElectronAppearanceGateway();
  const sleep = new PmsetSleepControl(log);
  const git = new GitCliRemotes();

  // `gh` runs with the login shell's PATH: launched from the Finder, the app's
  // own PATH has no Homebrew in it. `git` is /usr/bin's and needs nothing.
  const toolEnv = loginShellEnv(() => shells.resolve(shellProfileId()).path, terminals.baseEnv, log);
  const github = new GhCli({ run: async (args) => defaultGhRunner(await toolEnv())(args) });
  // The page and its actions need each other: the actions read the page's
  // items, and the page shows each item's action. Closed with `attach`.
  const sessionActions = new SessionActionService({
    prompter, store: new SqliteActivityStore(database.db), github, ids, clock, log,
  });
  const sessionWork = new SessionWorkService({
    locate: (sessionId) => {
      const cached = repository.getCachedSession(sessionId);
      if (cached) return { folder: cached.folder, projectPath: cached.projectPath };
      // Running but not indexed yet: its folder is the one the CLI writes to.
      const live = registry.find(sessionId)?.session;
      if (!live) return null;
      const remote = isRemoteProjectPath(live.projectPath);
      return { folder: remote ? null : encodeProjectPath(live.projectPath), projectPath: live.projectPath };
    },
    transcripts,
    git: new GitCliWorkspace(),
    github,
    remotes: git,
    activities: sessionActions,
    renderer, clock, timers, log,
  });
  sessionActions.attach(sessionWork);

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
          sessionWork.transcriptsChanged(folder);
        } else {
          sessionIndex.forgetFolder(folder);
        }
      }
      renderer.projectsChanged();
    },
  });

  return {
    log, paths,
    settings, repository, searchIndex, transcripts, fs,
    registry, terminals, shells, lifecycle, remote, launcher, transitions,
    questions, questionHook,
    sessionIndex, projects, usage, schedules, weather, updates, sessionWork, sessionActions,
    renderer, dialogs, system, appearance, sleep, git, projectsWatcher,
    setWindow: (next) => { window = next; },
    getWindow,
    close: () => {
      projectsWatcher.stop();
      sessionWork.closeAll();
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
