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
import os from 'node:os';
import path from 'node:path';

import { systemClock } from '../application/ports/clock';
import { uuidGenerator } from '../application/ports/ids';
import { QuestionService } from '../application/services/question-service';
import { ProjectListService } from '../application/services/project-list-service';
import { ProjectFolderService } from '../application/services/project-folder-service';
import { RemoteConnectionSupervisor } from '../application/services/remote-connection-supervisor';
import { ScheduleService } from '../application/services/schedule-service';
import { SessionIndex } from '../application/services/session-index';
import { SessionLauncher } from '../application/services/session-launcher';
import { SessionLifecycle } from '../application/services/session-lifecycle';
import { SessionTransitionDetector } from '../application/services/session-transition-detector';
import { SessionWorkService } from '../application/services/session-work-service';
import { IssueSessionService, type IssueSessionCandidate } from '../application/services/issue-session-service';
import { PlanService } from '../application/services/plan-service';
import { ProjectOverviewService } from '../application/services/project-overview-service';
import { ReviewService } from '../application/services/review-service';
import { SessionActionService } from '../application/services/session-action-service';
import { PrWatchService } from '../application/services/pr-watch-service';
import { SettingsService } from '../application/services/settings-service';
import { UpdateService } from '../application/services/update-service';
import { WeatherService } from '../application/services/weather-service';
import { ASK_PATCH_CALL, AskRouteService } from '../application/services/ask-route-service';
import { QUICK_ASK_ACCELERATOR, QuickAskHotkey } from '../application/services/quick-ask-hotkey';
import { QUICK_ROUTE_CALL, QuickAskService } from '../application/services/quick-ask-service';
import { SessionRegistry } from '../application/model/session-registry';

import { ShellClaudeCaller } from '../infrastructure/claude-cli/claude-caller';
import { ClaudeCommandRunner } from '../infrastructure/claude-cli/command-runner';
import { OAuthUsageService } from '../infrastructure/claude-cli/usage-service';
import {
  ElectronAppearanceGateway, ElectronDialogService, ElectronSystemGateway,
} from '../infrastructure/electron/desktop';
import { ElectronRendererGateway } from '../infrastructure/electron/renderer-gateway';
import { ElectronWindowDrag } from '../infrastructure/electron/window-drag';
import { ElectronDockAttention } from '../infrastructure/electron/dock-attention';
import { E2eGlobalHotkey, ElectronGlobalHotkey } from '../infrastructure/electron/global-hotkey';
import { QuickAskWindow } from '../infrastructure/electron/quick-ask-window';
import { hiddenForE2e } from '../infrastructure/electron/main-window';
import { FileTranscriptStore } from '../infrastructure/fs/transcript-store';
import { NodeFileSystem } from '../infrastructure/fs/node-file-system';
import { ClaudeJsonMcpServers } from '../infrastructure/claude-cli/mcp-servers';
import { ClaudeSkillCatalog } from '../infrastructure/claude-cli/skill-catalog';
import { ProjectsWatcher } from '../infrastructure/fs/projects-watcher';
import { NodePtyGateway } from '../infrastructure/pty/node-pty-gateway';
import { PtySessionPrompter } from '../infrastructure/pty/session-prompter';
import { SystemShellProfileProvider } from '../infrastructure/shell/shell-discovery';
import { WorkerProjectScanner } from '../infrastructure/worker/worker-project-scanner';
import { SqliteSearchIndex } from '../infrastructure/sqlite/search-index';
import { SqliteSessionRepository } from '../infrastructure/sqlite/session-repository';
import { SqliteSettingsStore } from '../infrastructure/sqlite/settings-store';
import { SqliteActivityStore } from '../infrastructure/sqlite/activity-store';
import { SqliteAutoFixHistory } from '../infrastructure/sqlite/auto-fix-history';
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
import type { GlobalHotkey, QuickAskPanel } from '../application/ports/quick-ask-panel';
import type { McpServers } from '../application/ports/mcp-servers';
import type { MainWindowHost } from '../application/ports/main-window';
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
  /** Checks a folder before it is added as a project (#171). */
  readonly projectFolders: ProjectFolderService;
  readonly usage: OAuthUsageService;
  readonly schedules: ScheduleService;
  readonly weather: WeatherService;
  readonly updates: UpdateService;
  readonly sessionWork: SessionWorkService;
  readonly sessionActions: SessionActionService;
  readonly review: ReviewService
  readonly prWatch: PrWatchService;
  readonly issueSessions: IssueSessionService;
  readonly plans: PlanService;
  readonly projectOverview: ProjectOverviewService;
  readonly askRoute: AskRouteService;
  readonly quickAskHotkey: QuickAskHotkey;
  readonly quickAskPanel: QuickAskPanel;
  readonly quickAsk: QuickAskService;
  readonly mcpServers: McpServers;
  /** The pop-up's window, once one exists. */
  quickAskWindow(): QuickAskWindow | null;
  /** Make the pop-up's window now, hidden, so the first press shows it at once (B1). */
  prepareQuickAsk(): void;

  readonly renderer: ElectronRendererGateway;
  readonly dialogs: ElectronDialogService;
  readonly windowDrag: ElectronWindowDrag;
  readonly dockAttention: ElectronDockAttention;
  readonly system: ElectronSystemGateway;
  readonly appearance: ElectronAppearanceGateway;
  readonly sleep: PmsetSleepControl;
  readonly git: GitCliRemotes;
  readonly projectsWatcher: ProjectsWatcher;

  /** The window, once one exists. Set by the app lifecycle. */
  setWindow(window: BrowserWindow | null): void;
  getWindow(): BrowserWindow | null;
  /** How the app lifecycle opens the window, for Quick Ask to open a closed one (R4). */
  setWindowOpener(open: (options: { inactive: boolean }) => void): void;

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
  let openWindow: (options: { inactive: boolean }) => void = () => {};
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
    receiver: {
      receive: (...args) => questions.receive(...args),
      receiveRound: (...args) => questions.receiveRound(...args),
      promptSubmitted: (...args) => questions.promptSubmitted(...args),
    },
    log,
  });
  const questions = new QuestionService({
    registry, renderer, prompter, clock, log, endpoint: questionHook,
  });

  const workspace = new GitCliWorkspace();
  const launcher = new SessionLauncher({
    registry, terminals, shells, transcripts, settings,
    lifecycle, remote, renderer, questions, clock, timers, log,
    git: workspace,
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
  // Ask Patch (#135): one Haiku call per request typed on the empty screen.
  const claudeCaller = new ShellClaudeCaller({ shells, terminals, timers, log, shellProfileId, homeDir: paths.homeDir });
  const askRoute = new AskRouteService({ cli: claudeCaller, timers, log, call: ASK_PATCH_CALL });

  // Quick Ask (#142): ⌥Space from anywhere. A window can only be made once the
  // app is ready, so the pop-up's is made by `prepareQuickAsk` at startup, or
  // by the first press when the setting was off then.
  let quickAskWindow: QuickAskWindow | null = null;
  // Listened to before the window is made, which may be at the first press.
  const shownListeners: (() => void)[] = [];
  const prepareQuickAsk = (): QuickAskWindow => {
    if (quickAskWindow) return quickAskWindow;
    quickAskWindow = new QuickAskWindow(appDir());
    quickAskWindow.onShown(() => shownListeners.forEach(listener => listener()));
    return quickAskWindow;
  };
  const quickAskPanel: QuickAskPanel = {
    show: () => prepareQuickAsk().show(),
    hide: () => quickAskWindow?.hide(),
    toggle: () => prepareQuickAsk().toggle(),
    get visible() { return quickAskWindow?.visible ?? false; },
    onShown: (listener) => { shownListeners.push(listener); },
  };
  const quickAskHotkey = new QuickAskHotkey({
    hotkey: process.env.SWITCHBOARD_E2E === '1' ? e2eHotkey(() => quickAskWindow) : new ElectronGlobalHotkey(),
    panel: quickAskPanel,
    settings, log,
  });
  // The session starts in the main window, which stays behind the app the user
  // is in; only the New Session picker brings it forward.
  const mainWindow: MainWindowHost = {
    ensureOpen: () => {
      if (!window) openWindow({ inactive: true });
    },
    bringForward: () => {
      if (!window) openWindow({ inactive: false });
      if (!window || window.isDestroyed() || hiddenForE2e()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      app.focus({ steal: true });
      window.focus();
    },
  };
  // Captures read the user's MCP servers from `~/.claude.json` (C2).
  const mcpServers = new ClaudeJsonMcpServers({ fs, homeDir: paths.homeDir, tempDir: os.tmpdir(), ids, log });
  // Its own routing service (R1): never cancels the empty-screen box's request.
  const quickAsk = new QuickAskService({
    router: new AskRouteService({ cli: claudeCaller, timers, log, call: QUICK_ROUTE_CALL }),
    projects, settings, renderer, mainWindow, log,
    // So a request that names a skill keeps its name (#142).
    skills: new ClaudeSkillCatalog({ fs, claudeDir: paths.claudeDir, log }),
    panel: quickAskPanel,
    popUp: { saving: (target) => quickAskWindow?.saving(target) },
    cli: claudeCaller, mcpServers, ids, timers,
  });

  // ── Host ──
  const dialogs = new ElectronDialogService(getWindow);
  const windowDrag = new ElectronWindowDrag(getWindow);
  const dockAttention = new ElectronDockAttention();
  const system = new ElectronSystemGateway(log);
  const appearance = new ElectronAppearanceGateway();
  const sleep = new PmsetSleepControl(log);
  const git = new GitCliRemotes();
  const projectFolders = new ProjectFolderService({ fs, git: workspace, remotes: git });

  // `gh` runs with the login shell's PATH: launched from the Finder, the app's
  // own PATH has no Homebrew in it. `git` is /usr/bin's and needs nothing.
  const toolEnv = loginShellEnv(() => shells.resolve(shellProfileId()).path, terminals.baseEnv, log);
  const github = new GhCli({ run: async (args) => defaultGhRunner(await toolEnv())(args) });
  // The page and its actions need each other: the actions read the page's
  // items, and the page shows each item's action. Closed with `attach`.
  const sessionActions = new SessionActionService({
    prompter, store: new SqliteActivityStore(database.db), github, ids, clock, log,
  });
  const locateSession = (sessionId: string): { folder: string | null; projectPath: string } | null => {
    const cached = repository.getCachedSession(sessionId);
    if (cached) return { folder: cached.folder, projectPath: cached.projectPath };
    // Running but not indexed yet: its folder is the one the CLI writes to.
    const live = registry.find(sessionId)?.session;
    if (!live) return null;
    const remote = isRemoteProjectPath(live.projectPath);
    return { folder: remote ? null : encodeProjectPath(live.projectPath), projectPath: live.projectPath };
  };
  const sessionWork = new SessionWorkService({
    locate: locateSession,
    transcripts,
    git: workspace,
    github,
    remotes: git,
    activities: sessionActions,
    renderer, clock, timers, log,
  });
  sessionActions.attach(sessionWork);
  const review = new ReviewService({ github, page: sessionWork, actions: sessionActions, log });
  // The Plan tab (#121): reads only, each answer kept for 30 s.
  const plans = new PlanService({ locate: locateSession, transcripts, git: workspace, remotes: git, github, clock });

  // Always on, page or no page (W1): the running Claude sessions' PRs, as
  // their transcripts linked them. Remote sessions are out of scope.
  const prWatch = new PrWatchService({
    sessions: () => registry.snapshot()
      .filter(([, session]) => !session.exited && !session.isPlainTerminal && !isRemoteProjectPath(session.projectPath))
      .map(([sessionId, session]) => {
        const cached = repository.getCachedSession(sessionId);
        return {
          sessionId,
          projectPath: session.projectPath,
          folder: cached?.folder ?? encodeProjectPath(session.projectPath),
          pullRequests: cached?.pullRequests ?? [],
        };
      }),
    github,
    history: new SqliteAutoFixHistory(database.db),
    actions: sessionActions,
    transcripts,
    git: workspace,
    renderer, clock, timers, log,
  });

  // Sessions on a plan's issues (#125): every listed session and every running
  // one may own an issue, and a new one starts in a worktree made here.
  const issueSessions = new IssueSessionService({
    sessions: () => {
      const meta = repository.getAllMeta();
      const candidates = new Map<string, IssueSessionCandidate>();
      for (const cached of repository.getAllCached()) {
        if (meta.get(cached.sessionId)?.archived) continue;
        candidates.set(cached.sessionId, {
          sessionId: cached.sessionId,
          projectPath: cached.projectPath,
          folder: cached.folder,
          activeAt: Date.parse(cached.modified) || 0,
          pullRequests: cached.pullRequests ?? [],
        });
      }
      for (const [sessionId, live] of registry.snapshot()) {
        if (live.exited || live.isPlainTerminal) continue;
        const listed = candidates.get(sessionId);
        if (listed) listed.activeAt = Math.max(listed.activeAt, live.openedAt);
        else {
          candidates.set(sessionId, {
            sessionId,
            projectPath: live.projectPath,
            folder: live.projectFolder ?? encodeProjectPath(live.projectPath),
            activeAt: live.openedAt,
            pullRequests: [],
          });
        }
      }
      return [...candidates.values()];
    },
    transcripts,
    git: workspace,
    remotes: git,
    github,
    clock, log,
  });

  // The project page (#172): one answer, plans through PlanService's cache.
  const projectOverview = new ProjectOverviewService({
    plans,
    owners: issueSessions,
    running: () => registry.snapshot()
      .filter(([, session]) => !session.exited && !session.isPlainTerminal)
      .map(([sessionId, session]) => ({ sessionId, projectPath: session.projectPath })),
    git: workspace,
    remotes: git,
    github,
    clock,
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
    sessionIndex, projects, projectFolders, usage, schedules, weather, updates, sessionWork, sessionActions, prWatch,
    review,
    issueSessions,
    plans,
    projectOverview,
    askRoute,
    quickAskHotkey,
    quickAskPanel,
    quickAsk,
    mcpServers,
    quickAskWindow: () => quickAskWindow,
    prepareQuickAsk: () => { prepareQuickAsk(); },
    renderer, dialogs, windowDrag, dockAttention, system, appearance, sleep, git, projectsWatcher,
    setWindow: (next) => { window = next; },
    getWindow,
    setWindowOpener: (open) => { openWindow = open; },
    close: () => {
      projectsWatcher.stop();
      prWatch.stop();
      sessionWork.closeAll();
      claudeCaller.close();
      // A capture cut short by quitting never reaches its `finally`.
      mcpServers.removeAll();
      database.close();
    },
  };
}

/**
 * The e2e suite's stand-in for ⌥Space, reachable from a test as
 * `globalThis.__switchboardTestHooks.quickAsk`: the real `globalShortcut` would
 * take the key from the developer's own Mac, and Playwright cannot press it.
 * It also tells whether the pop-up is showing, and whether it lets a click
 * through to the window underneath, which a hidden window cannot show.
 */
function e2eHotkey(window: () => QuickAskWindow | null): GlobalHotkey {
  const hotkey = new E2eGlobalHotkey();
  (globalThis as typeof globalThis & { __switchboardTestHooks?: unknown }).__switchboardTestHooks = {
    quickAsk: {
      press: () => hotkey.press(QUICK_ASK_ACCELERATOR),
      refuse: (refusing: boolean) => { hotkey.refusing = refusing; },
      visible: () => window()?.visible ?? false,
      passingThrough: () => window()?.passingThrough ?? true,
    },
  };
  return hotkey;
}

/** Where the packaged app keeps its data, isolated per instance when asked. */
export function isolateUserDataIfRequested(): void {
  // SWITCHBOARD_DATA_DIR isolates a dev/test instance from the installed app:
  // the database goes under it, and pointing userData there gives the instance
  // its own single-instance lock, so both can run side by side.
  if (!process.env.SWITCHBOARD_DATA_DIR) return;
  app.setPath('userData', path.resolve(process.env.SWITCHBOARD_DATA_DIR, 'electron'));
}
