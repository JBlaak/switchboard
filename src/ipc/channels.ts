/**
 * The channel names, in one place.
 *
 * They are strings on the wire, and a typo in one is a runtime `undefined`
 * rather than a compile error — so both sides name them from here and neither
 * spells one out. Grouped by direction, because that is what decides which
 * Electron primitive carries them.
 */

/** Renderer asks, main answers. */
export const INVOKE = {
    // Projects
    getProjects: 'get-projects',
    browseFolder: 'browse-folder',
    addProject: 'add-project',
    removeProject: 'remove-project',
    addRemoteProject: 'add-remote-project',
    removeRemoteProject: 'remove-remote-project',
    checkProjectFolder: 'check-project-folder',

    // Sessions
    getActiveSessions: 'get-active-sessions',
    getActiveTerminals: 'get-active-terminals',
    openTerminal: 'open-terminal',
    stopSession: 'stop-session',
    reconnectRemote: 'reconnect-remote',
    toggleStar: 'toggle-star',
    togglePlanPin: 'toggle-plan-pin',
    toggleIssuePlanPin: 'toggle-issue-plan-pin',
    toggleProjectPin: 'toggle-project-pin',
    renameSession: 'rename-session',
    archiveSession: 'archive-session',
    snoozeSession: 'snooze-session',
    getSessionStats: 'get-session-stats',

    // Questions
    getPendingQuestions: 'get-pending-questions',
    answerQuestions: 'answer-questions',

    // Grilling rounds
    grillViews: 'grill-views',
    grillAnswer: 'grill-answer',
    grillAsk: 'grill-ask',
    grillSend: 'grill-send',
    grillQueue: 'grill-queue',
    grillCancelQueue: 'grill-cancel-queue',

    // Usage
    getUsage: 'get-usage',

    // Weather
    getWeather: 'get-weather',
    geocodeWeatherLocation: 'geocode-weather-location',

    // Ask Patch
    askRoute: 'ask-route',
    cancelAskRoute: 'cancel-ask-route',
    warmAskRoute: 'warm-ask-route',

    // Sleep
    getSleepDisabled: 'get-sleep-disabled',
    setSleepDisabled: 'set-sleep-disabled',

    // Updates
    getUpdate: 'get-update',
    installUpdate: 'install-update',
    getUpdateOutcome: 'get-update-outcome',

    // Search
    search: 'search',

    // Settings
    getSetting: 'get-setting',
    setSetting: 'set-setting',
    getEffectiveSettings: 'get-effective-settings',
    getShellProfiles: 'get-shell-profiles',
    setAppearance: 'set-appearance',
    quickAskHotkeyStatus: 'quick-ask:hotkey-status',
    blaakTasksSetUp: 'blaak-tasks:set-up',
    savedPrompts: 'saved-prompts:get',
    setSavedPrompts: 'saved-prompts:set',

    // Quick Ask: the pop-up's own (#148)
    quickAskRoute: 'quick-ask:route',
    quickAskQuick: 'quick-ask:quick',
    quickAskCancel: 'quick-ask:cancel',
    quickAskStart: 'quick-ask:start',
    quickAskOpenPicker: 'quick-ask:open-picker',
    quickAskUndo: 'quick-ask:undo',

    // Host
    openExternal: 'open-external',
    openRepository: 'open-repository',
    writeClipboard: 'clipboard-write-text',
    writeClipboardImage: 'clipboard-write-image',
    getAppVersion: 'get-app-version',

    // Session work
    sessionWorkOpen: 'session-work:open',
    sessionWorkCanOpen: 'session-work:can-open',
    pullRequestPeek: 'pull-request:peek',
    sessionWorkDiff: 'session-work:diff',
    sessionWorkImage: 'session-work:image',
    sessionWorkRefinement: 'session-work:refinement',
    sessionWorkComment: 'session-work:comment',
    sessionWorkReview: 'session-work:review',
    sessionWorkCheckLog: 'session-work:check-log',

    // Session links: the session tray's Links group (#340)
    sessionLinks: 'session-links:get',

    // Plan: sessions on a plan's issues (#125)
    planIssueSessions: 'plan:issue-sessions',
    planPrepareIssueWorktree: 'plan:prepare-issue-worktree',
    // Plans (#123)
    planSessionPlans: 'plan:session-plans',
    planGet: 'plan:get',
    planProjectPlans: 'plan:project-plans',
    // The project page (#172)
    projectOverview: 'project:overview',
    projectCleanWorktrees: 'project:clean-worktrees',
    // The merge queue's buttons and errands (#315)
    queueNudge: 'queue:nudge',
    queueForgetNudge: 'queue:forget-nudge',
    queueSettleNudges: 'queue:settle-nudges',
    queueFix: 'queue:fix',
    queueRetry: 'queue:retry',
    queueOptIn: 'queue:opt-in',
    queueErrandStarted: 'queue:errand-started',
    queueErrandAbandoned: 'queue:errand-abandoned',
    queueErrands: 'queue:errands',
    // The CI job queue under the merge queue, and Bump
    ciJobQueue: 'queue:ci-jobs',
    ciJobBump: 'queue:ci-job-bump',

    // Tasks: BlaakTasks in Switchboard (#248)
    tasksList: 'tasks:list',
    tasksGet: 'tasks:get',
    tasksUpdate: 'tasks:update',
    tasksSetRepo: 'tasks:set-repo',
    tasksPrepareStart: 'tasks:prepare-start',
    tasksSessionStarted: 'tasks:session-started',
    tasksLinkSession: 'tasks:link-session',
    tasksUnlinkSession: 'tasks:unlink-session',
    tasksSessionTask: 'tasks:session-task',
    tasksSessionTasks: 'tasks:session-tasks',
    tasksTaskSessions: 'tasks:task-sessions',
    tasksProjectTasks: 'tasks:project-tasks',
    tasksWatch: 'tasks:watch',
    tasksUnwatch: 'tasks:unwatch',

    // Phone access (#194)
    phoneAccessGet: 'phone-access:get',
    phoneAccessSetEnabled: 'phone-access:set-enabled',
    phoneAccessStartPairing: 'phone-access:start-pairing',
    phoneAccessStopPairing: 'phone-access:stop-pairing',
    phoneAccessConfirmPairing: 'phone-access:confirm-pairing',
    phoneAccessRevoke: 'phone-access:revoke',
    phoneAccessReset: 'phone-access:reset',
    terminalOwners: 'terminal-owners',
    useTerminalHere: 'use-terminal-here',

    // VM hosts: the Switchboard agent (#276)
    agentStatus: 'agent:status',
    agentInstall: 'agent:install',
    agentCheckTools: 'agent:check-tools',
    agentHostSettings: 'agent:host-settings',
    agentSetHostSettings: 'agent:set-host-settings',
    agentOpenSetupTerminal: 'agent:open-setup-terminal',

    // Project hand-off to a VM (#276 stage 2)
    handoffHosts: 'handoff:hosts',
    handoffPreview: 'handoff:preview',
    handoffRun: 'handoff:hand-off',
    handoffForStart: 'handoff:for-start',
    handoffCopiesOf: 'handoff:copies-of',
    handoffOriginOf: 'handoff:origin-of',
    handoffCopyStatus: 'handoff:copy-status',
    handoffBringBack: 'handoff:bring-back',
    handoffRemoveCopy: 'handoff:remove-copy',

    // Session hand-off to a VM (#276 stage 3)
    sessionHandoffPreview: 'session-handoff:preview',
    sessionHandoffRun: 'session-handoff:hand-off',
    sessionHandoffCancel: 'session-handoff:cancel',

    // A VM session brought back to this Mac (#276): the counterpart of its hand-off
    sessionBringBackPreview: 'session-bring-back:preview',
    sessionBringBackRun: 'session-bring-back:bring-back',
    sessionBringBackCancel: 'session-bring-back:cancel',

    // Stage 5 (#276): where schedules run, and files dropped on a VM session's terminal
    vmSchedulesWhere: 'vm-schedules:where',
    vmSchedulesRunOn: 'vm-schedules:run-on',
    droppedFilesToSession: 'dropped-files:to-session',

    // Settings → VMs: VMs registered on their own, as phones are (#276, #307)
    vmRegistryList: 'vm-registry:list',
    vmRegistryAdd: 'vm-registry:add',
    vmRegistryRename: 'vm-registry:rename',
    vmRegistryRemove: 'vm-registry:remove',

    // The session tray's Workspace group (#342)
    workspaceEditor: 'workspace:editor',
    workspaceOpenInEditor: 'workspace:open-in-editor',
    workspaceRevealInFinder: 'workspace:reveal-in-finder',
    workspaceShellHere: 'workspace:shell-here',
} as const;

/** Renderer tells main; no answer expected. */
export const SEND = {
    terminalInput: 'terminal-input',
    terminalResize: 'terminal-resize',
    closeTerminal: 'close-terminal',
    sessionWorkClose: 'session-work:close',
    windowDragStart: 'window-drag:start',
    windowDragMove: 'window-drag:move',
    windowDragEnd: 'window-drag:end',
    needsInputCount: 'needs-input-count',
    quickAskDismiss: 'quick-ask:dismiss',
    quickAskPointerOverSlab: 'quick-ask:pointer-over-slab',
    headsUpAnswer: 'heads-up:answer',
    headsUpReady: 'heads-up:ready',
    rendererReady: 'renderer-ready',
} as const;

/** Main tells the renderer, unprompted. */
export const EVENT = {
    terminalData: 'terminal-data',
    processExited: 'process-exited',
    sessionForked: 'session-forked',
    cliBusyState: 'cli-busy-state',
    terminalNotification: 'terminal-notification',
    sessionNeedsAttention: 'session-needs-attention',
    sessionAgents: 'session-agents',
    sessionBackgroundTasks: 'session-background-tasks',
    remoteStatus: 'remote-status',
    questionsAsked: 'questions-asked',
    questionsSettled: 'questions-settled',
    grillChanged: 'grill-changed',
    pageShown: 'page:shown',
    projectsChanged: 'projects-changed',
    statusUpdate: 'status-update',
    fullscreenChanged: 'fullscreen-changed',
    updateAvailable: 'update-available',
    updateProgress: 'update-progress',
    sessionWorkSnapshot: 'session-work:snapshot',
    pullRequestLinkOpened: 'pull-request:link-opened',
    prStatusChanged: 'pr-status:changed',
    mergeQueueChanged: 'merge-queue:changed',
    launchRequested: 'quick-ask:launch-requested',
    pickerRequested: 'quick-ask:picker-requested',
    phoneAccessChanged: 'phone-access:changed',
    terminalOwnerChanged: 'terminal-owner:changed',
    sessionStarted: 'session:started',
    sessionArchived: 'session:archived',
    tasksChanged: 'tasks:changed',
    sessionTaskChanged: 'tasks:session-task-changed',
    agentInstallProgress: 'agent:install-progress',
    handoffProgress: 'handoff:progress',
    bringBackProgress: 'handoff:bring-back-progress',
    sessionHandoffPhase: 'session-handoff:phase',
    sessionBringBackPhase: 'session-bring-back:phase',
    vmHostsChanged: 'vm-registry:changed',
} as const;

/** Main tells the Quick Ask pop-up, unprompted; it is a window of its own (#142). */
export const QUICK_ASK_EVENT = {
    shown: 'quick-ask:shown',
    closeRequested: 'quick-ask:close-requested',
    saving: 'quick-ask:saving',
} as const;

/** Main tells the 1Password heads-up pop-up, unprompted; it is a window of its own. */
export const HEADS_UP_EVENT = {
    shown: 'heads-up:shown',
} as const;
