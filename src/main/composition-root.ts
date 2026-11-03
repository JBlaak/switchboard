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
import {app, safeStorage} from 'electron';
import {randomBytes} from 'node:crypto';
import {createHash} from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {systemClock} from '../application/ports/clock';
import {uuidGenerator} from '../application/ports/ids';
import {AgentAwareTerminals} from '../application/services/agent-client/agent-aware-terminals';
import {AgentClient} from '../application/services/agent-client/agent-client';
import {isAgentPty} from '../application/services/agent-client/agent-pty';
import {ConfigCopyService, manifestStoreOn} from '../application/services/config-copy-service';
import {SshAgentDialer} from '../infrastructure/agent/ssh-agent-dialer';
import {AgentHostsService} from '../application/services/agent-hosts-service';
import {ProjectHandoffService} from '../application/services/project-handoff-service';
import {SessionHandoffService} from '../application/services/session-handoff-service';
import {VmTranscripts} from '../application/services/vm-transcripts';
import {VmSchedulesService} from '../application/services/vm-schedules-service';
import {DroppedFilesService} from '../application/services/dropped-files-service';
import {isVmFolder} from '../domain/agent/vm-paths';
import type {VmSchedules} from '../application/services/vm-schedules';
import type {DroppedFiles} from '../application/services/dropped-files';
import {SqliteVmTranscriptStore} from '../infrastructure/sqlite/vm-transcript-store';
import {GitCliHandoff} from '../infrastructure/git/git-cli-handoff';
import {forgetRemoteProject} from './forget-remote-project';
import {AgentUpgrades} from '../application/services/agent-upgrades';
import {AgentInstallerService} from '../application/services/agent-installer-service';
import {setupTerminalCommand} from '../domain/agent/setup-script';
import {AgentBundleBuilder, agentBundleSources} from '../infrastructure/ssh/agent-bundle';
import {OpenSshProvisioner} from '../infrastructure/ssh/ssh-provisioner';
import {NodeClaudeConfigSource} from '../infrastructure/fs/claude-config-source';
import {QuestionService} from '../application/services/question-service';
import {ProjectListService} from '../application/services/project-list-service';
import {ProjectFolderService} from '../application/services/project-folder-service';
import {RemoteConnectionSupervisor} from '../application/services/remote-connection-supervisor';
import {ScheduleService} from '../application/services/schedule-service';
import {SessionIndex} from '../application/services/session-index';
import {SessionLauncher} from '../application/services/session-launcher';
import {SessionLifecycle} from '../application/services/session-lifecycle';
import {SessionTransitionDetector} from '../application/services/session-transition-detector';
import {SessionWorkService} from '../application/services/session-work-service';
import {IssueSessionService, type IssueSessionCandidate} from '../application/services/issue-session-service';
import {PlanService} from '../application/services/plan-service';
import {ProjectOverviewService} from '../application/services/project-overview-service';
import {ReviewService} from '../application/services/review-service';
import {SessionActionService} from '../application/services/session-action-service';
import {PrWatchService} from '../application/services/pr-watch-service';
import {SettingsService} from '../application/services/settings-service';
import {WorktreeCleanupService} from '../application/services/worktree-cleanup-service';
import {UpdateService} from '../application/services/update-service';
import {WeatherService} from '../application/services/weather-service';
import {ASK_PATCH_CALL, AskRouteService} from '../application/services/ask-route-service';
import {QUICK_ASK_ACCELERATOR, QuickAskHotkey} from '../application/services/quick-ask-hotkey';
import {QuickAskService, quickRouteCall} from '../application/services/quick-ask-service';
import {TaskLinkService} from '../application/services/task-link-service';
import {TaskSessionService} from '../application/services/task-session-service';
import {TaskWritesService} from '../application/services/task-writes-service';
import {TasksService} from '../application/services/tasks-service';
import {SessionRegistry} from '../application/model/session-registry';

import {ShellClaudeCaller} from '../infrastructure/claude-cli/claude-caller';
import {ClaudeCommandRunner} from '../infrastructure/claude-cli/command-runner';
import {OAuthUsageService} from '../infrastructure/claude-cli/usage-service';
import {
    ElectronAppIconGateway,
    ElectronAppearanceGateway,
    ElectronDialogService,
    ElectronSystemGateway,
} from '../infrastructure/electron/desktop';
import {ElectronRendererGateway} from '../infrastructure/electron/renderer-gateway';
import {ElectronWindowDrag} from '../infrastructure/electron/window-drag';
import {ElectronDockAttention} from '../infrastructure/electron/dock-attention';
import {E2eGlobalHotkey, ElectronGlobalHotkey} from '../infrastructure/electron/global-hotkey';
import {QuickAskWindow} from '../infrastructure/electron/quick-ask-window';
import {hiddenForE2e} from '../infrastructure/electron/main-window';
import {FileTranscriptStore} from '../infrastructure/fs/transcript-store';
import {NodeFileSystem} from '../infrastructure/fs/node-file-system';
import {ClaudeJsonMcpServers} from '../infrastructure/claude-cli/mcp-servers';
import {ClaudeSkillCatalog} from '../infrastructure/claude-cli/skill-catalog';
import {ProjectsWatcher} from '../infrastructure/fs/projects-watcher';
import {NodePtyGateway} from '../infrastructure/pty/node-pty-gateway';
import {PtySessionPrompter} from '../infrastructure/pty/session-prompter';
import {SystemShellProfileProvider} from '../infrastructure/shell/shell-discovery';
import {WorkerProjectScanner} from '../infrastructure/worker/worker-project-scanner';
import {SqliteSearchIndex} from '../infrastructure/sqlite/search-index';
import {SqliteSessionRepository} from '../infrastructure/sqlite/session-repository';
import {SqliteSettingsStore} from '../infrastructure/sqlite/settings-store';
import {SqliteActivityStore} from '../infrastructure/sqlite/activity-store';
import {SqliteAutoFixHistory} from '../infrastructure/sqlite/auto-fix-history';
import {SqliteTaskLinkStore} from '../infrastructure/sqlite/task-link-store';
import {McpBlaakTasks} from '../infrastructure/blaaktasks/mcp-blaak-tasks';
import {openDatabase} from '../infrastructure/sqlite/database';
import {resolveClaudePaths} from '../infrastructure/fs/claude-paths';
import {systemTimers} from '../infrastructure/system/timers';
import {OpenMeteoWeatherSource} from '../infrastructure/weather/open-meteo';
import {PmsetSleepControl} from '../infrastructure/system/pmset-sleep-control';
import {PmsetBatteryGauge} from '../infrastructure/system/pmset-battery-gauge';
import {BundleInstaller} from '../infrastructure/system/bundle-installer';
import {GitHubReleaseFeed} from '../infrastructure/github/github-release-feed';
import {GitCliRemotes} from '../infrastructure/git/git-cli-remotes';
import {RoutingGitRemotes, RoutingGitWorkspace} from '../infrastructure/git/routing-git';
import type {VmGitRouting} from '../infrastructure/git/routing-git';
import {agentlessRemoteGuard} from '../domain/project/agentless-remote';
import {RoutingTranscriptStore} from '../infrastructure/agent/routing-transcript-store';
import {locateVmSession} from '../application/services/vm-session-location';
import {SelfArchiveCatchUp} from '../application/services/self-archive-catch-up';
import {GitCliWorkspace} from '../infrastructure/git/git-cli-workspace';
import {GhCli, defaultGhRunner} from '../infrastructure/github/gh-cli';
import {loginShellEnv} from '../infrastructure/shell/login-shell-env';
import {encodeProjectPath} from '../domain/project/project-path';
import {isRemoteProjectPath, remoteProjectPath} from '../domain/project/remote-target';
import {routeCandidates} from '../domain/ask/route';
import {resolveBlaakTasksUrl} from '../domain/settings/settings';
import {QuestionHookServer} from '../infrastructure/http/question-hook-server';
import {ArchiveToolService} from '../application/services/archive-tool-service';
import {OpensslIdentityStore} from '../infrastructure/phone/identity-store';
import {DnsSdAdvertiser} from '../infrastructure/phone/dns-sd-advertiser';
import {LanWatcher} from '../infrastructure/phone/lan-watcher';
import {WhisperCliTranscriber} from '../infrastructure/voice/whisper-cli-transcriber';
import {WhisperModelStore} from '../infrastructure/voice/whisper-model-store';
import {SqliteDeviceRegistry} from '../infrastructure/sqlite/device-registry';
import {bonjourHostName, computerName} from '../infrastructure/system/computer-name';
import {PhoneEventTee, buildPhoneAccess} from './phone-access';
import {sessionArchiver, stopSession} from './stop-session';
import type {PhoneAccessService} from '../application/services/phone-access-service';
import type {PhoneSessionsService} from '../application/services/phone-sessions-service';
import type {DeviceRegistry, ServiceAdvertiser} from '../application/ports/phone-access';
import type {RendererGateway} from '../application/ports/renderer-gateway';
import type {Encryption} from '../infrastructure/phone/identity-store';

import type {BrowserWindow} from 'electron';
import type {GlobalHotkey, QuickAskPanel} from '../application/ports/quick-ask-panel';
import type {McpServers} from '../application/ports/mcp-servers';
import type {MainWindowHost} from '../application/ports/main-window';
import type {SwitchboardDatabase} from '../infrastructure/sqlite/database';
import type {AgentHosts} from '../application/services/agent-hosts';
import type {ProjectHandoff} from '../application/services/project-handoff';
import type {SessionHandoff} from '../application/services/session-handoff';

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
    readonly terminals: AgentAwareTerminals<NodePtyGateway>;
    /** Links to VM agents (#276): one per host, and the stand-ins for their sessions. */
    readonly agents: AgentClient;
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
    readonly review: ReviewService;
    readonly prWatch: PrWatchService;
    readonly issueSessions: IssueSessionService;
    /** Removes an archived session's worktrees, when Settings says to. */
    readonly worktreeCleanup: WorktreeCleanupService;
    readonly plans: PlanService;
    readonly projectOverview: ProjectOverviewService;
    readonly askRoute: AskRouteService;
    readonly quickAskHotkey: QuickAskHotkey;
    readonly quickAskPanel: QuickAskPanel;
    readonly quickAsk: QuickAskService;
    readonly mcpServers: McpServers;
    /** BlaakTasks (#248): its services exist only while a URL is set in Settings. */
    readonly tasks: TasksService;
    /**
     * VM hosts (#276): status, install, setup checks, host settings and the setup
     * terminal. Optional only until `buildContainer` builds it.
     */
    readonly agentHosts: AgentHosts;
    /**
     * Project hand-off to a VM (#276 stage 2): copies, Bring back and removing a
     * copy. Optional only until `buildContainer` builds it.
     */
    readonly projectHandoff: ProjectHandoff;
    /**
     * Session hand-off to a VM (#276 stage 3): a running session moved to a
     * host, waiting for its turn to end first. Optional only until
     * `buildContainer` builds it.
     */
    readonly sessionHandoff: SessionHandoff;
    /** VM sessions' transcripts, parsed on their VMs (#276 stage 3). */
    readonly vmTranscripts: VmTranscripts;
    /**
     * Where a project's schedules run, on the Mac or in a copy on its VM (#276
     * stage 5). Optional only until `buildContainer` builds it.
     */
    readonly vmSchedules: VmSchedules;
    /**
     * Files dropped on a VM session's terminal, uploaded to its VM (#276 stage
     * 5). Optional only until `buildContainer` builds it.
     */
    readonly droppedFiles: DroppedFiles;
    /** The pop-up's window, once one exists. */
    quickAskWindow(): QuickAskWindow | null;
    /** Make the pop-up's window now, hidden, so the first press shows it at once (B1). */
    prepareQuickAsk(): void;

    /** The window's gateway with the phones listening in; what every service pushes through. */
    readonly renderer: RendererGateway;
    /** The window's own gateway, for what only it does (Quick Ask's ready handshake). */
    readonly windowRenderer: ElectronRendererGateway;
    readonly dialogs: ElectronDialogService;
    readonly windowDrag: ElectronWindowDrag;
    readonly dockAttention: ElectronDockAttention;
    readonly system: ElectronSystemGateway;
    readonly appearance: ElectronAppearanceGateway;
    readonly appIcon: ElectronAppIconGateway;
    readonly sleep: PmsetSleepControl;
    readonly git: GitCliRemotes;
    readonly projectsWatcher: ProjectsWatcher;

    // ── Phone access (#194) ──
    readonly phoneAccess: PhoneAccessService;
    /** The phones' side of the sessions; the terminal handlers ask it who owns a terminal. */
    readonly phoneSessions: PhoneSessionsService;
    /** Withdrawn by hand at quit, before the async shutdown, so no `dns-sd` outlives the app. */
    readonly phoneAdvertiser: ServiceAdvertiser;
    /** Restarts the listener when the Mac's LAN addresses change. */
    readonly lanWatcher: LanWatcher;

    /** The window, once one exists. Set by the app lifecycle. */
    setWindow(window: BrowserWindow | null): void;
    getWindow(): BrowserWindow | null;
    /** How the app lifecycle opens the window, for Quick Ask to open a closed one (R4). */
    setWindowOpener(open: (options: {inactive: boolean}) => void): void;

    close(): void;
}

/** The directory the built bundles live in — `app/` beside this module. */
function appDir(): string {
    return __dirname;
}

/** How much of a transcript's end is read for the task its BlaakTasks calls name. */
const TASK_SCAN_BYTES = 512 * 1024;

export function buildContainer(): Container {
    // ── Primitives ──
    const paths = resolveClaudePaths();
    const clock = systemClock;
    const timers = systemTimers;
    const ids = uuidGenerator;
    const fs = new NodeFileSystem();

    let window: BrowserWindow | null = null;
    const getWindow = (): BrowserWindow | null => window;
    let openWindow: (options: {inactive: boolean}) => void = () => {};
    const windowRenderer = new ElectronRendererGateway(getWindow);
    // Built last, under Phone access; until then the tee only feeds the window.
    let phoneSessions: PhoneSessionsService | null = null;
    const renderer = new PhoneEventTee(windowRenderer, () => phoneSessions);

    // ── Stores ──
    const database: SwitchboardDatabase = openDatabase();
    const repository = new SqliteSessionRepository(database.db);
    const searchIndex = new SqliteSearchIndex(database.db, database.searchFtsRecreated);
    const settingsStore = new SqliteSettingsStore(database.db);
    const settings = new SettingsService(settingsStore);
    const transcripts = new FileTranscriptStore(fs, paths.projectsDir);

    // ── Session machinery ──
    const registry = new SessionRegistry();
    // Every PTY handle goes through this, so a VM session's stand-in (#276) is
    // signalled and checked over its link, and everything else by node-pty.
    const terminals = new AgentAwareTerminals(new NodePtyGateway());
    const shells = new SystemShellProfileProvider();
    // Types the Session work actions into a session, and hears it go idle from the lifecycle.
    const prompter = new PtySessionPrompter({sessions: registry, timers, log});

    // The lifecycle needs the supervisor to interpret a remote session's exit;
    // the supervisor needs the lifecycle to wire the PTY a reconnect produces.
    // Constructed in that order and closed with `attach`.
    const remote = new RemoteConnectionSupervisor({
        registry,
        terminals,
        renderer,
        timers,
        clock,
        log,
        homeDir: paths.homeDir,
    });
    const lifecycle = new SessionLifecycle({
        registry,
        terminals,
        renderer,
        remote,
        timers,
        log,
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
        archiveTool: {
            request: (...args) => archiveTool.request(...args),
            turnEnded: (...args) => archiveTool.turnEnded(...args),
        },
        log,
    });
    const questions = new QuestionService({
        registry,
        renderer,
        prompter,
        clock,
        log,
        endpoint: questionHook,
    });
    // A session archiving itself (`archive_session`), as a phone's archive does.
    // The archiver is built on the first call: the worktree cleanup it ends with
    // is made further down.
    const archiveTool = new ArchiveToolService({
        registry,
        endpoint: questionHook,
        log,
        archiver: {
            archive: (sessionId) =>
                sessionArchiver({
                    registry,
                    remote,
                    lifecycle,
                    terminals,
                    repository,
                    renderer,
                    worktreeCleanup,
                    tasks,
                }).archive(sessionId),
        },
    });

    // VM hosts (#276). The agent's question hook forwards here, so the Mac's own
    // QuestionService and archive tool answer a VM session as they answer a local one.
    const agents = new AgentClient({
        dialer: new SshAgentDialer({
            shell: () => shells.resolve(shellProfileId()).path,
            env: terminals.baseEnv,
            cwd: paths.homeDir,
            log,
        }),
        appVersion: app.getVersion(),
        registry,
        renderer,
        questions,
        archiveTool,
        timers,
        clock,
        log,
    });
    // The global config copy (#283), on every (re)connect to a host that wants it.
    const configCopy = new ConfigCopyService({
        source: new NodeClaudeConfigSource(path.join(os.homedir(), '.claude'), os.homedir()),
        manifests: manifestStoreOn(settingsStore),
        logger: log,
    });
    agents.onConnected((connection) => {
        const hostSettings = connection.settings;
        if (!hostSettings) return;
        void configCopy.copyTo(
            connection.host,
            {
                copyConfig: async ({files, removed}) => {
                    const done = await connection.copyConfig(files, removed);
                    return {ok: done.ok, ...(done.error ? {error: done.error} : {})};
                },
            },
            hostSettings,
        );
    });

    // `gh`, and the filters a git checkout runs (`git-lfs`), need the login
    // shell's PATH: launched from the Finder, the app's own has no Homebrew in it.
    const toolEnv = loginShellEnv(() => shells.resolve(shellProfileId()).path, terminals.baseEnv, log);
    // The Mac's own git. The pages get `workspace` below, which routes a VM
    // project's paths (#276 stage 4) through its agent; the launcher only ever
    // asks about local folders, so it keeps this one.
    const localWorkspace = new GitCliWorkspace(toolEnv);
    const launcher = new SessionLauncher({
        registry,
        terminals,
        shells,
        transcripts,
        settings,
        lifecycle,
        remote,
        renderer,
        questions,
        archiveTool,
        clock,
        timers,
        log,
        git: localWorkspace,
        fileExists: (target) => fs.exists(target),
        agents,
    });

    // Installing the agent on a VM (#281) and answering the UI's questions about
    // its hosts (#282), joined in one façade.
    const agentInstaller = new AgentInstallerService({
        provisioner: new OpenSshProvisioner(toolEnv, log),
        settings,
        bundles: new AgentBundleBuilder(
            agentBundleSources({
                isPackaged: app.isPackaged,
                resourcesPath: process.resourcesPath,
                appRoot: app.getAppPath(),
                tmpDir: os.tmpdir(),
            }),
        ),
        appVersion: app.getVersion(),
        log,
        clock,
    });
    const agentHosts = new AgentHostsService({
        agents,
        installer: {
            installedVersion: async (projectPath) => (await agentInstaller.status(projectPath)).installed,
            install: (projectPath, onProgress) => agentInstaller.install(projectPath, onProgress),
        },
        launcher,
        setupCommand: setupTerminalCommand(),
        appVersion: app.getVersion(),
        ids,
        log,
    });
    // When a VM's agent is upgraded on its own: see AgentUpgrades.
    const agentUpgrades = new AgentUpgrades({
        appVersion: app.getVersion(),
        agentProjectOn: (host) => {
            const onHost = settings
                .remoteProjects()
                .find((r) => r.user === host.user && r.host === host.host && r.port === host.port && r.agent);
            return onHost ? remoteProjectPath(onHost) : null;
        },
        install: (projectPath) => agentInstaller.install(projectPath),
        redial: (host) => agents.connection(host).retryNow(),
        log,
    });
    agents.onNeedsReinstall((host, reason) => void agentUpgrades.protocolMismatch(host, reason));
    agents.onConnected((connection) => void agentUpgrades.connected(connection));

    // Handing projects off to VMs (#276 stage 2). Forgetting a removed copy
    // reaches back into the container, which exists by the time anyone removes one.
    let forgetRemote: (projectPath: string) => void = () => {};
    // Where each project's schedules run (#276 stage 5): on this Mac, or in one
    // copy on its VM, kept in step with the VM's host settings on every connect.
    const vmSchedules = new VmSchedulesService({agents, settings, fs, renderer, clock, timers, log});
    vmSchedules.start();
    const handoffGit = new GitCliHandoff(toolEnv);
    const projectHandoff = new ProjectHandoffService({
        afterHandoff: (localPath, copyPath, choices) => vmSchedules.afterHandoff(localPath, copyPath, choices),
        agents,
        git: handoffGit,
        settings,
        renderer,
        forgetRemoteProject: (projectPath) => forgetRemote(projectPath),
        timers,
        log,
    });

    const transitions = new SessionTransitionDetector({
        registry,
        transcripts,
        renderer,
        clock,
        log,
    });

    // ── Indexing ──
    const scanner = new WorkerProjectScanner({
        workerPath: path.join(appDir(), 'workers', 'scan-projects.js'),
        projectsDir: paths.projectsDir,
        log,
    });
    const sessionIndex = new SessionIndex({
        repository,
        searchIndex,
        transcripts,
        scanner,
        renderer,
        timers,
        log,
    });

    // VM sessions' titles, PR links and search text, from the transcripts their
    // VMs parse (#276 stage 3). Built before any host connects: it listens for them.
    const vmTranscripts = new VmTranscripts({
        agents,
        remoteProjects: () => settings.remoteProjects(),
        store: new SqliteVmTranscriptStore(database.db),
        searchIndex,
        names: repository,
        renderer,
        log,
    });
    const projects = new ProjectListService({repository, transcripts, settings, registry, vmTranscripts});
    // Moving a running conversation to a VM (#276 stage 3).
    const sessionHandoff = new SessionHandoffService({
        registry,
        sessions: repository,
        transcripts,
        git: handoffGit,
        projects: projectHandoff,
        agents,
        prompter,
        stop: (sessionId) => stopSession({registry, remote, lifecycle, terminals}, sessionId),
        launcher,
        settings,
        renderer,
        sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
        clock,
        timers,
        log,
    });

    // ── Feature services ──
    const usage = new OAuthUsageService(log);
    const weather = new WeatherService({
        source: new OpenMeteoWeatherSource(clock, log),
        settings,
        clock,
        log,
    });
    const updates = new UpdateService({
        feed: new GitHubReleaseFeed({owner: 'JBlaak', name: 'switchboard'}),
        installer: new BundleInstaller(log),
        renderer,
        timers,
        log,
        currentVersion: app.getVersion(),
        arch: process.arch,
    });
    const shellProfileId = (): string => settings.shellProfileId(null);

    const schedules = new ScheduleService({
        fs,
        transcripts,
        repository,
        ids,
        clock,
        timers,
        log,
        commandsDir: paths.commandsDir,
        runner: new ClaudeCommandRunner({shells, terminals, log, shellProfileId}),
        // A project whose schedules run on a VM is paused here (#276 stage 5).
        runsHere: (projectPath) => vmSchedules.macRunsSchedulesOf(projectPath),
    });
    // Ask Patch (#135): one Haiku call per request typed on the empty screen.
    const claudeCaller = new ShellClaudeCaller({
        shells,
        terminals,
        timers,
        log,
        shellProfileId,
        homeDir: paths.homeDir,
    });
    const askRoute = new AskRouteService({cli: claudeCaller, timers, log, call: ASK_PATCH_CALL});

    // Quick Ask (#142): ⌥Space from anywhere. A window can only be made once the
    // app is ready, so the pop-up's is made by `prepareQuickAsk` at startup, or
    // by the first press when the setting was off then.
    let quickAskWindow: QuickAskWindow | null = null;
    // Listened to before the window is made, which may be at the first press.
    const shownListeners: (() => void)[] = [];
    const prepareQuickAsk = (): QuickAskWindow => {
        if (quickAskWindow) return quickAskWindow;
        quickAskWindow = new QuickAskWindow(appDir());
        quickAskWindow.onShown(() => shownListeners.forEach((listener) => listener()));
        return quickAskWindow;
    };
    const quickAskPanel: QuickAskPanel = {
        show: () => prepareQuickAsk().show(),
        hide: () => quickAskWindow?.hide(),
        toggle: () => prepareQuickAsk().toggle(),
        get visible() {
            return quickAskWindow?.visible ?? false;
        },
        onShown: (listener) => {
            shownListeners.push(listener);
        },
    };
    const quickAskHotkey = new QuickAskHotkey({
        hotkey: process.env.SWITCHBOARD_E2E === '1' ? e2eHotkey(() => quickAskWindow) : new ElectronGlobalHotkey(),
        panel: quickAskPanel,
        settings,
        log,
    });
    // The session starts in the main window, which stays behind the app the user
    // is in; only the New Session picker brings it forward.
    const mainWindow: MainWindowHost = {
        ensureOpen: () => {
            if (!window) openWindow({inactive: true});
        },
        bringForward: () => {
            if (!window) openWindow({inactive: false});
            if (!window || window.isDestroyed() || hiddenForE2e()) return;
            if (window.isMinimized()) window.restore();
            window.show();
            app.focus({steal: true});
            window.focus();
        },
    };
    // Captures read the user's MCP servers from `~/.claude.json` (C2).
    const mcpServers = new ClaudeJsonMcpServers({fs, homeDir: paths.homeDir, tempDir: os.tmpdir(), ids, log});
    // Its own routing service (R1): never cancels the empty-screen box's request.
    const quickAsk = new QuickAskService({
        router: new AskRouteService({cli: claudeCaller, timers, log, call: quickRouteCall(settings)}),
        projects,
        settings,
        renderer,
        mainWindow,
        log,
        // So a request that names a skill keeps its name (#142).
        skills: new ClaudeSkillCatalog({fs, claudeDir: paths.claudeDir, log}),
        panel: quickAskPanel,
        popUp: {saving: (target) => quickAskWindow?.saving(target)},
        cli: claudeCaller,
        mcpServers,
        ids,
        timers,
    });

    // ── Host ──
    const dialogs = new ElectronDialogService(getWindow);
    const windowDrag = new ElectronWindowDrag(getWindow);
    const dockAttention = new ElectronDockAttention();
    const system = new ElectronSystemGateway(log);
    const appearance = new ElectronAppearanceGateway();
    // Beside the window icon: build/ is packaged next to app/.
    const appIcon = new ElectronAppIconGateway(path.join(appDir(), '..', 'build', 'dock'), log);
    const sleep = new PmsetSleepControl(log);
    // Git for the pages, routed by path: a VM project's (`ssh://user@host//abs`)
    // goes through its host's agent, everything else to the Mac's own git.
    const vmGit: VmGitRouting = {
        isAgentHost: (host) =>
            settings
                .remoteProjects()
                .some((r) => r.user === host.user && r.host === host.host && r.port === host.port && !!r.agent),
        tools: (host) => agents.connection(host),
    };
    const workspace = new RoutingGitWorkspace(localWorkspace, vmGit);
    const git = new RoutingGitRemotes(new GitCliRemotes(), vmGit);
    const projectFolders = new ProjectFolderService({fs, git: localWorkspace, remotes: new GitCliRemotes()});
    // Only agentless remotes are turned away now; a VM project's pages are served.
    const agentlessRemote = agentlessRemoteGuard(() => settings.remoteProjects());
    // Transcripts for the pages: a VM session's folder (`vm:…`) is asked of its
    // VM; it never dials, so an offline VM answers empty.
    const routedTranscripts = new RoutingTranscriptStore({
        local: transcripts,
        link: (host) => {
            const connection = agents.connection({...host});
            return connection.connected ? connection : null;
        },
        log,
    });

    const github = new GhCli({run: async (args) => defaultGhRunner(await toolEnv())(args)});
    // The page and its actions need each other: the actions read the page's
    // items, and the page shows each item's action. Closed with `attach`.
    const sessionActions = new SessionActionService({
        prompter,
        store: new SqliteActivityStore(database.db),
        github,
        ids,
        clock,
        log,
    });
    const vmLocation = {
        live: (id: string) => {
            const session = registry.find(id)?.session;
            return session ? {projectPath: session.projectPath, onAgent: isAgentPty(session.pty)} : null;
        },
        remoteProjects: () => settings.remoteProjects(),
        vmCwd: (id: string) => vmTranscripts.cwd(id),
    };
    const locateSession = (sessionId: string): {folder: string | null; projectPath: string} | null => {
        const cached = repository.getCachedSession(sessionId);
        if (cached) return {folder: cached.folder, projectPath: cached.projectPath};
        const onVm = locateVmSession(vmLocation, sessionId);
        if (onVm) return onVm;
        // Running but not indexed yet: its folder is the one the CLI writes to.
        const live = registry.find(sessionId)?.session;
        if (!live) return null;
        const remote = isRemoteProjectPath(live.projectPath);
        return {folder: remote ? null : encodeProjectPath(live.projectPath), projectPath: live.projectPath};
    };
    const sessionWork = new SessionWorkService({
        locate: locateSession,
        transcripts: routedTranscripts,
        agentlessRemote,
        git: workspace,
        github,
        remotes: git,
        activities: sessionActions,
        renderer,
        clock,
        timers,
        log,
    });
    sessionActions.attach(sessionWork);
    const review = new ReviewService({github, page: sessionWork, actions: sessionActions, log});
    // The Plan tab (#121): reads only, each answer kept for 30 s.
    const plans = new PlanService({
        locate: locateSession,
        transcripts: routedTranscripts,
        agentlessRemote,
        git: workspace,
        remotes: git,
        github,
        clock,
    });

    // Always on, page or no page (W1): the running Claude sessions' PRs, as
    // their transcripts linked them. Remote sessions are out of scope.
    const prWatch = new PrWatchService({
        sessions: () =>
            registry
                .snapshot()
                // Local sessions, and VM sessions (#276 stage 3), whose PR links come
                // from the transcripts their VMs parse. A session on an agentless
                // remote has no transcript here at all.
                .filter(
                    ([, session]) =>
                        !session.exited &&
                        !session.isPlainTerminal &&
                        (!isRemoteProjectPath(session.projectPath) || isAgentPty(session.pty)),
                )
                .map(([sessionId, session]) => {
                    if (isAgentPty(session.pty)) {
                        return {
                            sessionId,
                            projectPath: session.projectPath,
                            folder: null,
                            pullRequests: vmTranscripts.pullRequests(sessionId),
                        };
                    }
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
        renderer,
        clock,
        timers,
        log,
    });

    // Sessions on a plan's issues (#125): every listed session and every running
    // one may own an issue, and a new one starts in a worktree made here. The
    // archived ones own none, but may be the one an existing branch was worked on in.
    const sessionCandidates = (): IssueSessionCandidate[] => {
        const meta = repository.getAllMeta();
        const candidates = new Map<string, IssueSessionCandidate>();
        for (const cached of repository.getAllCached()) {
            candidates.set(cached.sessionId, {
                sessionId: cached.sessionId,
                projectPath: cached.projectPath,
                folder: cached.folder,
                activeAt: Date.parse(cached.modified) || 0,
                pullRequests: cached.pullRequests ?? [],
                ...(meta.get(cached.sessionId)?.archived ? {archived: true} : {}),
            });
        }
        for (const [sessionId, live] of registry.snapshot()) {
            if (live.exited || live.isPlainTerminal) continue;
            const listed = candidates.get(sessionId);
            if (listed) {
                listed.activeAt = Math.max(listed.activeAt, live.openedAt);
                // Running, it may own an issue though it is archived.
                delete listed.archived;
            } else {
                candidates.set(sessionId, {
                    sessionId,
                    projectPath: live.projectPath,
                    folder: isAgentPty(live.pty)
                        ? (locateVmSession(vmLocation, sessionId)?.folder ?? null)
                        : (live.projectFolder ?? encodeProjectPath(live.projectPath)),
                    activeAt: live.openedAt,
                    pullRequests: [],
                });
            }
        }
        return [...candidates.values()];
    };
    const issueSessions = new IssueSessionService({
        sessions: sessionCandidates,
        transcripts: routedTranscripts,
        agentlessRemote,
        git: workspace,
        remotes: git,
        github,
        clock,
        log,
    });

    // Archiving removes the session's worktrees, when Settings says to.
    const worktreeCleanup = new WorktreeCleanupService({
        enabled: () => settings.removeWorktreeOnArchive(),
        locate: locateSession,
        transcripts: routedTranscripts,
        agentlessRemote,
        git: workspace,
        otherSessionPaths: (sessionId) => {
            const meta = repository.getAllMeta();
            const paths = repository
                .getAllCached()
                .filter((cached) => cached.sessionId !== sessionId && !meta.get(cached.sessionId)?.archived)
                .map((cached) => cached.projectPath);
            for (const [id, live] of registry.snapshot()) {
                if (id !== sessionId && !live.exited) paths.push(live.projectPath);
            }
            return paths;
        },
        log,
    });

    // The project page (#172): one answer, plans through PlanService's cache.
    const projectOverview = new ProjectOverviewService({
        plans,
        owners: issueSessions,
        running: () =>
            registry
                .snapshot()
                .filter(([, session]) => !session.exited && !session.isPlainTerminal)
                .map(([sessionId, session]) => ({sessionId, projectPath: session.projectPath})),
        git: workspace,
        remotes: git,
        github,
        clock,
        agentlessRemote,
    });

    // BlaakTasks (#248): built only while a URL is set, and again when it changes.
    // Starting from a task routes with its own Ask Patch, never cancelling the
    // empty screen's request; the writes read a PR's state as the CI watch heard it.
    const taskLinkStore = new SqliteTaskLinkStore(database.db);
    const tasks = new TasksService({
        url: () => resolveBlaakTasksUrl(settings.global() as Record<string, unknown>),
        build: (url) => {
            const blaakTasks = new McpBlaakTasks({url: () => url, mcpServers, log});
            const links = new TaskLinkService({store: taskLinkStore, sessions: sessionCandidates, clock});
            const starts = new TaskSessionService({
                sessions: sessionCandidates,
                transcripts: routedTranscripts,
                agentlessRemote,
                git: workspace,
                repoOf: (taskId) => links.repoOf(taskId),
                candidates: () => routeCandidates(projects.list(false)),
                router: new AskRouteService({cli: claudeCaller, timers, log, call: ASK_PATCH_CALL}),
            });
            const writes = new TaskWritesService({
                tasks: blaakTasks,
                links,
                pullRequests: (sessionId) => repository.getCachedSession(sessionId)?.pullRequests ?? [],
                pullRequestState: (url) => prWatch.stateOf(url) ?? null,
                log,
            });
            return {tasks: blaakTasks, links, starts, writes};
        },
        renderer,
        sessionsIn: (folder) =>
            registry
                .snapshot()
                // Local sessions, and VM sessions by their VM transcript folder (#276 stage 5).
                .filter(
                    ([, session]) =>
                        !session.exited &&
                        !session.isPlainTerminal &&
                        (!isRemoteProjectPath(session.projectPath) || isAgentPty(session.pty)),
                )
                .filter(
                    ([sessionId, session]) =>
                        (isAgentPty(session.pty)
                            ? locateVmSession(vmLocation, sessionId)?.folder
                            : (session.projectFolder ?? encodeProjectPath(session.projectPath))) === folder,
                )
                .map(([sessionId, session]) => ({sessionId, projectPath: session.projectPath})),
        transcript: (folder, sessionId) =>
            isVmFolder(folder)
                ? vmTranscripts.tail(sessionId, TASK_SCAN_BYTES)
                : transcripts.readTail(folder, sessionId, TASK_SCAN_BYTES).split('\n'),
        modifiedAt: (folder, sessionId) => {
            if (!isVmFolder(folder)) return transcripts.sessionMtimeMs(folder, sessionId);
            const at = Date.parse(vmTranscripts.get(sessionId)?.modified ?? '');
            return Number.isNaN(at) ? null : at;
        },
        pullRequests: (sessionId) => repository.getCachedSession(sessionId)?.pullRequests ?? [],
        archived: (sessionId) => Boolean(repository.getAllMeta().get(sessionId)?.archived),
        sessionProject: (sessionId) => locateSession(sessionId)?.projectPath ?? null,
        repoRoot: async (projectPath) => (await workspace.mainCheckout(projectPath)) ?? projectPath,
        clock,
        timers,
        log,
    });

    // Every write the CLI makes to a transcript arrives here: re-index the folder,
    // check whether a session forked, and refresh the sidebar once per burst.
    const projectsWatcher = new ProjectsWatcher({
        fs,
        timers,
        log,
        projectsDir: paths.projectsDir,
        onFoldersChanged: (folders) => {
            for (const folder of folders) {
                if (transcripts.folderExists(folder)) {
                    transitions.detect(folder);
                    sessionIndex.refreshFolder(folder);
                    sessionWork.transcriptsChanged(folder);
                    // After the index, so the PRs it just read go on the session's task.
                    void tasks.transcriptsChanged(folder);
                } else {
                    sessionIndex.forgetFolder(folder);
                }
            }
            renderer.projectsChanged();
        },
    });

    // ── Phone access (#194) ──
    // The e2e suite listens on loopback, keeps its key out of the Keychain and
    // never advertises: a run must not put a service on the developer's Wi-Fi.
    const e2e = process.env.SWITCHBOARD_E2E === '1';
    const phoneAdvertiser: ServiceAdvertiser = e2e
        ? loopbackAdvertiser()
        : new DnsSdAdvertiser({log, localName: bonjourHostName});
    const phone = buildPhoneAccess({
        identity: new OpensslIdentityStore({
            directory: path.join(app.getPath('userData'), 'phone-access'),
            encryption: e2e ? plainEncryption : keychainEncryption,
        }),
        devices: whileOpen(new SqliteDeviceRegistry(database.db), () => database.db.open),
        advertiser: phoneAdvertiser,
        ...(e2e ? {addresses: () => ['127.0.0.1']} : {}),
        registry,
        running: lifecycle,
        projects,
        questions,
        // Its own instance per phone (#194): a phone's request never cancels the Mac's.
        router: () => new AskRouteService({cli: claudeCaller, timers, log, call: ASK_PATCH_CALL}),
        launcher,
        archiver: sessionArchiver({
            registry,
            remote,
            lifecycle,
            terminals,
            repository,
            renderer,
            worktreeCleanup,
            tasks,
        }),
        settings,
        renderer,
        // Hold-to-talk: Whisper's model is fetched into user data on first use.
        voice: {
            transcriber: new WhisperCliTranscriber({log}),
            model: new WhisperModelStore({directory: path.join(app.getPath('userData'), 'voice'), log}),
            cli: claudeCaller,
        },
        battery: e2e ? {read: async () => null} : new PmsetBatteryGauge(),
        ids,
        clock,
        timers,
        log,
        randomBytes: (length) => randomBytes(length),
        macName: computerName(),
        appVersion: app.getVersion(),
    });
    phoneSessions = phone.sessions;
    // Loopback never changes, so the e2e suite has nothing to watch.
    const lanWatcher = new LanWatcher({
        timers,
        ...(e2e ? {addresses: () => ['127.0.0.1']} : {}),
        onChange: () => {
            log.info('[phone] the LAN addresses changed; restarting the listener');
            phone.access.restart().catch((err: Error) => log.error('[phone] restart failed:', err.message));
        },
    });

    // A VM session's transcript changed: its task detection runs, as a local one's
    // does on the projects watcher (#276 stage 5).
    agents.onConnected((connection) =>
        connection.onMessage((message) => {
            if (message.type !== 'transcripts-changed') return;
            for (const sessionId of message.sessionIds) {
                const folder = locateVmSession(vmLocation, sessionId)?.folder;
                if (folder) void tasks.transcriptsChanged(folder);
            }
        }),
    );
    // VM sessions that archived themselves while the Mac was away (#308): their
    // rows are archived on every connect, as the archive tool would have, minus the stop.
    const selfArchiveCatchUp = new SelfArchiveCatchUp({
        appVersion: app.getVersion(),
        remoteProjects: () => settings.remoteProjects(),
        archiver: sessionArchiver({
            registry,
            remote,
            lifecycle,
            terminals,
            repository,
            renderer,
            worktreeCleanup,
            tasks,
        }),
        log,
    });
    agents.onConnected((connection) => void selfArchiveCatchUp.connected(connection));
    // Files dropped on a VM session's terminal go up to its VM (#276 stage 5).
    const droppedFiles = new DroppedFilesService({
        registry,
        agents,
        files: {
            stat: (file) => {
                const stat = nodeFs.statSync(file, {throwIfNoEntry: false});
                return stat ? {isFile: stat.isFile(), size: stat.size} : null;
            },
            read: (file) => nodeFs.readFileSync(file),
            basename: (file) => path.basename(file),
        },
        sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
        log,
    });

    const container: Container = {
        log,
        paths,
        settings,
        repository,
        searchIndex,
        transcripts,
        fs,
        registry,
        terminals,
        agents,
        agentHosts,
        projectHandoff,
        sessionHandoff,
        vmTranscripts,
        vmSchedules,
        droppedFiles,
        shells,
        lifecycle,
        remote,
        launcher,
        transitions,
        questions,
        questionHook,
        sessionIndex,
        projects,
        projectFolders,
        usage,
        schedules,
        weather,
        updates,
        sessionWork,
        sessionActions,
        prWatch,
        review,
        issueSessions,
        worktreeCleanup,
        plans,
        projectOverview,
        askRoute,
        quickAskHotkey,
        quickAskPanel,
        quickAsk,
        mcpServers,
        tasks,
        quickAskWindow: () => quickAskWindow,
        prepareQuickAsk: () => {
            prepareQuickAsk();
        },
        phoneAccess: phone.access,
        phoneSessions: phone.sessions,
        phoneAdvertiser,
        lanWatcher,
        renderer,
        windowRenderer,
        dialogs,
        windowDrag,
        dockAttention,
        system,
        appearance,
        appIcon,
        sleep,
        git,
        projectsWatcher,
        setWindow: (next) => {
            // A closed window's task surfaces watch nothing any more.
            if (next !== window) tasks.unwatchAll();
            window = next;
        },
        getWindow,
        setWindowOpener: (open) => {
            openWindow = open;
        },
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
    forgetRemote = (projectPath) => forgetRemoteProject(container, projectPath);
    return container;
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
    (globalThis as typeof globalThis & {__switchboardTestHooks?: unknown}).__switchboardTestHooks = {
        quickAsk: {
            press: () => hotkey.press(QUICK_ASK_ACCELERATOR),
            refuse: (refusing: boolean) => {
                hotkey.refusing = refusing;
            },
            visible: () => window()?.visible ?? false,
            passingThrough: () => window()?.passingThrough ?? true,
        },
    };
    return hotkey;
}

/**
 * The Mac's Phone access key at rest: Electron safeStorage, which on macOS is
 * a key in the login Keychain. Checked per call, since it is only usable once
 * the app is ready and the identity is first read well after that.
 */
const keychainEncryption: Encryption = {
    encrypt: (text) => {
        requireSafeStorage();
        return safeStorage.encryptString(text);
    },
    decrypt: (data) => {
        requireSafeStorage();
        return safeStorage.decryptString(data);
    },
};

function requireSafeStorage(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('the Keychain cannot encrypt it on this Mac');
}

/** The e2e suite's stand-in: its keys are throwaways in a fixture directory, and a Keychain prompt would hang the run. */
const plainEncryption: Encryption = {
    encrypt: (text) => Buffer.from(text, 'utf8'),
    decrypt: (data) => data.toString('utf8'),
};

/**
 * The device table, read as empty once quitting has closed the database: a
 * phone's connection that only finishes closing after that must not throw.
 */
function whileOpen(devices: DeviceRegistry, open: () => boolean): DeviceRegistry {
    return {
        list: () => (open() ? devices.list() : []),
        findByFingerprint: (fingerprint) => (open() ? devices.findByFingerprint(fingerprint) : null),
        add: (device) => devices.add(device),
        remove: (id) => devices.remove(id),
        touch: (id, at) => {
            if (open()) devices.touch(id, at);
        },
        clear: () => devices.clear(),
    };
}

/** The e2e suite's advertiser: says where it would advertise, and doesn't. */
function loopbackAdvertiser(): ServiceAdvertiser {
    return {
        advertise: (name, port) => log.info(`[phone] (e2e) not advertising "${name}" on port ${port}`),
        withdraw: () => {},
        hostName: () => '127.0.0.1',
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
