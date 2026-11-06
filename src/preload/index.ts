/**
 * The context-isolation bridge.
 *
 * Nothing but wiring: every method forwards to a channel from the shared table,
 * and the shape it forwards is the shared contract. The renderer runs with
 * nodeIntegration off, so this is the only surface it has — which is why it
 * stays a flat, auditable list rather than exposing `ipcRenderer` itself.
 */
import {contextBridge, ipcRenderer, webUtils} from 'electron';
import {EVENT, INVOKE, SEND} from '../ipc/channels';
import type {SwitchboardApi, Unsubscribe} from '../ipc/api';

type ChannelListener = Parameters<typeof ipcRenderer.on>[1];

/**
 * Listen on a push channel, answering the call that stops listening.
 *
 * The listener handed to `ipcRenderer` is the wrapper, not the renderer's
 * callback (which never sees the Electron event), so the wrapper is what has
 * to be removed again.
 */
function subscribe(channel: string, listener: ChannelListener): Unsubscribe {
    ipcRenderer.on(channel, listener);
    return () => {
        ipcRenderer.removeListener(channel, listener);
    };
}

const api: SwitchboardApi = {
    // ── Projects ──
    getProjects: (showArchived) => ipcRenderer.invoke(INVOKE.getProjects, showArchived),
    browseFolder: () => ipcRenderer.invoke(INVOKE.browseFolder),
    addProject: (projectPath) => ipcRenderer.invoke(INVOKE.addProject, projectPath),
    removeProject: (projectPath) => ipcRenderer.invoke(INVOKE.removeProject, projectPath),
    addRemoteProject: (config) => ipcRenderer.invoke(INVOKE.addRemoteProject, config),
    removeRemoteProject: (projectPath) => ipcRenderer.invoke(INVOKE.removeRemoteProject, projectPath),
    checkProjectFolder: (typed) => ipcRenderer.invoke(INVOKE.checkProjectFolder, typed),

    // ── Sessions ──
    getActiveSessions: () => ipcRenderer.invoke(INVOKE.getActiveSessions),
    getActiveTerminals: () => ipcRenderer.invoke(INVOKE.getActiveTerminals),
    openTerminal: (id, projectPath, isNew, sessionOptions) =>
        ipcRenderer.invoke(INVOKE.openTerminal, id, projectPath, isNew, sessionOptions),
    stopSession: (id) => ipcRenderer.invoke(INVOKE.stopSession, id),
    reconnectRemote: (id) => ipcRenderer.invoke(INVOKE.reconnectRemote, id),
    toggleStar: (id) => ipcRenderer.invoke(INVOKE.toggleStar, id),
    togglePlanPin: (projectPath, slug) => ipcRenderer.invoke(INVOKE.togglePlanPin, projectPath, slug),
    toggleIssuePlanPin: (projectPath, repository, number, title) =>
        ipcRenderer.invoke(INVOKE.toggleIssuePlanPin, projectPath, repository, number, title),
    renameSession: (id, name) => ipcRenderer.invoke(INVOKE.renameSession, id, name),
    archiveSession: (id, archived) => ipcRenderer.invoke(INVOKE.archiveSession, id, archived),
    snoozeSession: (id, until) => ipcRenderer.invoke(INVOKE.snoozeSession, id, until),

    // ── Questions ──
    getPendingQuestions: () => ipcRenderer.invoke(INVOKE.getPendingQuestions),
    answerQuestions: (sessionId, toolUseId, answers) =>
        ipcRenderer.invoke(INVOKE.answerQuestions, sessionId, toolUseId, answers),

    // ── Phone access (#194) ──
    getPhoneAccess: () => ipcRenderer.invoke(INVOKE.phoneAccessGet),
    setPhoneAccessEnabled: (enabled) => ipcRenderer.invoke(INVOKE.phoneAccessSetEnabled, enabled),
    startPhonePairing: () => ipcRenderer.invoke(INVOKE.phoneAccessStartPairing),
    stopPhonePairing: () => ipcRenderer.invoke(INVOKE.phoneAccessStopPairing),
    confirmPhonePairing: (requestId, accept) => ipcRenderer.invoke(INVOKE.phoneAccessConfirmPairing, requestId, accept),
    revokePhoneDevice: (deviceId) => ipcRenderer.invoke(INVOKE.phoneAccessRevoke, deviceId),
    resetPhoneIdentity: () => ipcRenderer.invoke(INVOKE.phoneAccessReset),
    getTerminalOwners: () => ipcRenderer.invoke(INVOKE.terminalOwners),
    useTerminalHere: (sessionId) => ipcRenderer.invoke(INVOKE.useTerminalHere, sessionId),

    // ── Usage ──
    getUsage: () => ipcRenderer.invoke(INVOKE.getUsage),

    // ── Weather ──
    getWeather: () => ipcRenderer.invoke(INVOKE.getWeather),
    geocodeWeatherLocation: (name) => ipcRenderer.invoke(INVOKE.geocodeWeatherLocation, name),

    // ── Ask Patch ──
    askRoute: (request) => ipcRenderer.invoke(INVOKE.askRoute, request),
    cancelAskRoute: () => ipcRenderer.invoke(INVOKE.cancelAskRoute),
    warmAskRoute: () => ipcRenderer.invoke(INVOKE.warmAskRoute),

    // ── Sleep ──
    getSleepDisabled: () => ipcRenderer.invoke(INVOKE.getSleepDisabled),
    setSleepDisabled: (disabled) => ipcRenderer.invoke(INVOKE.setSleepDisabled, disabled),

    // ── Updates ──
    getUpdate: () => ipcRenderer.invoke(INVOKE.getUpdate),
    installUpdate: () => ipcRenderer.invoke(INVOKE.installUpdate),

    // ── Search ──
    search: (type, query, titleOnly) => ipcRenderer.invoke(INVOKE.search, type, query, titleOnly),

    // ── Settings ──
    getSetting: (key) => ipcRenderer.invoke(INVOKE.getSetting, key),
    setSetting: (key, value) => ipcRenderer.invoke(INVOKE.setSetting, key, value),
    getEffectiveSettings: (projectPath) => ipcRenderer.invoke(INVOKE.getEffectiveSettings, projectPath),
    getShellProfiles: () => ipcRenderer.invoke(INVOKE.getShellProfiles),
    setAppearance: (mode) => ipcRenderer.invoke(INVOKE.setAppearance, mode),
    quickAskHotkeyStatus: () => ipcRenderer.invoke(INVOKE.quickAskHotkeyStatus),
    blaakTasksSetUp: (url) => ipcRenderer.invoke(INVOKE.blaakTasksSetUp, url),

    // ── Host ──
    openExternal: (url) => ipcRenderer.invoke(INVOKE.openExternal, url),
    openRepository: (projectPath) => ipcRenderer.invoke(INVOKE.openRepository, projectPath),
    writeClipboard: (text) => ipcRenderer.invoke(INVOKE.writeClipboard, text),
    writeClipboardImage: (png) => ipcRenderer.invoke(INVOKE.writeClipboardImage, png),
    getAppVersion: () => ipcRenderer.invoke(INVOKE.getAppVersion),

    // ── Session work ──
    openSessionWork: (sessionId) => ipcRenderer.invoke(INVOKE.sessionWorkOpen, sessionId),
    canOpenSessionWork: (sessionId) => ipcRenderer.invoke(INVOKE.sessionWorkCanOpen, sessionId),
    getSessionWorkDiff: (request) => ipcRenderer.invoke(INVOKE.sessionWorkDiff, request),
    sessionWorkImage: (request) => ipcRenderer.invoke(INVOKE.sessionWorkImage, request),
    sessionWorkAction: (request) => ipcRenderer.invoke(INVOKE.sessionWorkAction, request),
    cancelSessionWorkAction: (activityId) => ipcRenderer.invoke(INVOKE.sessionWorkCancel, activityId),
    sessionWorkComment: (request) => ipcRenderer.invoke(INVOKE.sessionWorkComment, request),
    sessionWorkReview: (request) => ipcRenderer.invoke(INVOKE.sessionWorkReview, request),
    getCheckLog: (request) => ipcRenderer.invoke(INVOKE.sessionWorkCheckLog, request),

    // ── Settings → VMs (#276, #307) ──
    vmHosts: () => ipcRenderer.invoke(INVOKE.vmRegistryList),
    addVmHost: (input) => ipcRenderer.invoke(INVOKE.vmRegistryAdd, input),
    renameVmHost: (key, name) => ipcRenderer.invoke(INVOKE.vmRegistryRename, key, name),
    removeVmHost: (key) => ipcRenderer.invoke(INVOKE.vmRegistryRemove, key),
    onVmHostsChanged: (cb) => subscribe(EVENT.vmHostsChanged, () => cb()),
    // ── VM hosts (#276) ──
    agentStatus: (projectPath) => ipcRenderer.invoke(INVOKE.agentStatus, projectPath),
    installAgent: (projectPath) => ipcRenderer.invoke(INVOKE.agentInstall, projectPath),
    checkAgentTools: (projectPath) => ipcRenderer.invoke(INVOKE.agentCheckTools, projectPath),
    agentHostSettings: (projectPath) => ipcRenderer.invoke(INVOKE.agentHostSettings, projectPath),
    setAgentHostSettings: (projectPath, settings) =>
        ipcRenderer.invoke(INVOKE.agentSetHostSettings, projectPath, settings),
    openAgentSetupTerminal: (projectPath) => ipcRenderer.invoke(INVOKE.agentOpenSetupTerminal, projectPath),
    // ── Project hand-off (#276 stage 2) ──
    handoffHosts: () => ipcRenderer.invoke(INVOKE.handoffHosts),
    previewHandoff: (localPath) => ipcRenderer.invoke(INVOKE.handoffPreview, localPath),
    handOffProject: (localPath, hostKey, ticked, choices) =>
        ipcRenderer.invoke(INVOKE.handoffRun, localPath, hostKey, ticked, choices),
    projectCopies: (localPath) => ipcRenderer.invoke(INVOKE.handoffCopiesOf, localPath),
    copyOrigin: (copyPath) => ipcRenderer.invoke(INVOKE.handoffOriginOf, copyPath),
    copyStatus: (copyPath) => ipcRenderer.invoke(INVOKE.handoffCopyStatus, copyPath),
    bringBackCopy: (copyPath) => ipcRenderer.invoke(INVOKE.handoffBringBack, copyPath),
    removeCopy: (copyPath) => ipcRenderer.invoke(INVOKE.handoffRemoveCopy, copyPath),
    previewSessionHandoff: (sessionId) => ipcRenderer.invoke(INVOKE.sessionHandoffPreview, sessionId),
    handOffSession: (sessionId, hostKey, ticked) =>
        ipcRenderer.invoke(INVOKE.sessionHandoffRun, sessionId, hostKey, ticked),
    cancelSessionHandoff: (sessionId) => ipcRenderer.invoke(INVOKE.sessionHandoffCancel, sessionId),
    // ── Stage 5 (#276): where schedules run, files dropped on a VM terminal ──
    schedulesWhere: (projectPath) => ipcRenderer.invoke(INVOKE.vmSchedulesWhere, projectPath),
    runSchedulesOn: (localPath, copyPath) => ipcRenderer.invoke(INVOKE.vmSchedulesRunOn, localPath, copyPath),
    uploadDroppedFiles: (sessionId, localPaths) =>
        ipcRenderer.invoke(INVOKE.droppedFilesToSession, sessionId, localPaths),
    // ── Plan: sessions on a plan's issues (#125) ──
    issueSessions: (repository) => ipcRenderer.invoke(INVOKE.planIssueSessions, repository),
    prepareIssueWorktree: (request) => ipcRenderer.invoke(INVOKE.planPrepareIssueWorktree, request),
    // ── Plans (#123) ──
    sessionPlans: (sessionId) => ipcRenderer.invoke(INVOKE.planSessionPlans, sessionId),
    plan: (repo, number) => ipcRenderer.invoke(INVOKE.planGet, repo, number),
    projectPlans: (projectPath, options) => ipcRenderer.invoke(INVOKE.planProjectPlans, projectPath, options),
    // ── The project page (#172) ──
    projectOverview: (projectPath, options) => ipcRenderer.invoke(INVOKE.projectOverview, projectPath, options),
    projectCleanWorktrees: (projectPath) => ipcRenderer.invoke(INVOKE.projectCleanWorktrees, projectPath),
    // ── The merge queue (#315) ──
    queueNudge: (request) => ipcRenderer.invoke(INVOKE.queueNudge, request),
    queueForgetNudge: (repository, number, reviewer) =>
        ipcRenderer.invoke(INVOKE.queueForgetNudge, repository, number, reviewer),
    queueSettleNudges: (repository, held) => ipcRenderer.invoke(INVOKE.queueSettleNudges, repository, held),
    queueFix: (request) => ipcRenderer.invoke(INVOKE.queueFix, request),
    queueRetry: (repository, number) => ipcRenderer.invoke(INVOKE.queueRetry, repository, number),
    queueOptIn: (repository, number) => ipcRenderer.invoke(INVOKE.queueOptIn, repository, number),
    queueErrandStarted: (errandId, sessionId) => ipcRenderer.invoke(INVOKE.queueErrandStarted, errandId, sessionId),
    queueErrandAbandoned: (errandId) => ipcRenderer.invoke(INVOKE.queueErrandAbandoned, errandId),
    queueErrands: (repository) => ipcRenderer.invoke(INVOKE.queueErrands, repository),
    ciJobQueue: (repository) => ipcRenderer.invoke(INVOKE.ciJobQueue, repository),
    ciJobBump: (request) => ipcRenderer.invoke(INVOKE.ciJobBump, request),

    // ── Tasks (#248) ──
    listTasks: (query) => ipcRenderer.invoke(INVOKE.tasksList, query),
    getTask: (taskId) => ipcRenderer.invoke(INVOKE.tasksGet, taskId),
    updateTask: (taskId, change) => ipcRenderer.invoke(INVOKE.tasksUpdate, taskId, change),
    setTaskRepo: (taskId, projectPath) => ipcRenderer.invoke(INVOKE.tasksSetRepo, taskId, projectPath),
    prepareTaskStart: (request) => ipcRenderer.invoke(INVOKE.tasksPrepareStart, request),
    taskSessionStarted: (taskId, sessionId, projectPath) =>
        ipcRenderer.invoke(INVOKE.tasksSessionStarted, taskId, sessionId, projectPath),
    linkSessionTask: (sessionId, taskId) => ipcRenderer.invoke(INVOKE.tasksLinkSession, sessionId, taskId),
    unlinkSessionTask: (sessionId) => ipcRenderer.invoke(INVOKE.tasksUnlinkSession, sessionId),
    sessionTask: (sessionId) => ipcRenderer.invoke(INVOKE.tasksSessionTask, sessionId),
    sessionTasks: () => ipcRenderer.invoke(INVOKE.tasksSessionTasks),
    taskSessions: (taskId) => ipcRenderer.invoke(INVOKE.tasksTaskSessions, taskId),
    projectTasks: (projectPath) => ipcRenderer.invoke(INVOKE.tasksProjectTasks, projectPath),
    watchTasks: (watchId, query) => ipcRenderer.invoke(INVOKE.tasksWatch, watchId, query),
    unwatchTasks: (watchId) => ipcRenderer.invoke(INVOKE.tasksUnwatch, watchId),

    // ── Fire-and-forget ──
    sendInput: (id, data) => ipcRenderer.send(SEND.terminalInput, id, data),
    resizeTerminal: (id, cols, rows) => ipcRenderer.send(SEND.terminalResize, id, cols, rows),
    closeTerminal: (id) => ipcRenderer.send(SEND.closeTerminal, id),
    closeSessionWork: (sessionId) => ipcRenderer.send(SEND.sessionWorkClose, sessionId),
    startWindowDrag: () => ipcRenderer.send(SEND.windowDragStart),
    moveWindowDrag: (dx, dy) => ipcRenderer.send(SEND.windowDragMove, dx, dy),
    endWindowDrag: () => ipcRenderer.send(SEND.windowDragEnd),
    setNeedsInputCount: (count) => ipcRenderer.send(SEND.needsInputCount, count),
    rendererReady: () => ipcRenderer.send(SEND.rendererReady),

    // ── Events from main ──
    onTerminalData: (cb) => subscribe(EVENT.terminalData, (_e, sessionId, data) => cb(sessionId, data)),
    onProcessExited: (cb) => subscribe(EVENT.processExited, (_e, sessionId, exitCode) => cb(sessionId, exitCode)),
    onSessionForked: (cb) => subscribe(EVENT.sessionForked, (_e, oldId, newId) => cb(oldId, newId)),
    onCliBusyState: (cb) => subscribe(EVENT.cliBusyState, (_e, sessionId, busy) => cb(sessionId, busy)),
    onTerminalNotification: (cb) =>
        subscribe(EVENT.terminalNotification, (_e, sessionId, message) => cb(sessionId, message)),
    onSessionNeedsAttention: (cb) => subscribe(EVENT.sessionNeedsAttention, (_e, sessionId) => cb(sessionId)),
    onSessionAgents: (cb) => subscribe(EVENT.sessionAgents, (_e, sessionId, agents) => cb(sessionId, agents)),
    onRemoteStatus: (cb) => subscribe(EVENT.remoteStatus, (_e, sessionId, status) => cb(sessionId, status)),
    onQuestionsAsked: (cb) => subscribe(EVENT.questionsAsked, (_e, pending) => cb(pending)),
    onQuestionsSettled: (cb) => subscribe(EVENT.questionsSettled, (_e, settled) => cb(settled)),
    onPageShown: (cb) => subscribe(EVENT.pageShown, (_e, page) => cb(page)),
    onProjectsChanged: (cb) => subscribe(EVENT.projectsChanged, () => cb()),
    onStatusUpdate: (cb) => subscribe(EVENT.statusUpdate, (_e, text, type) => cb(text, type)),
    onFullscreenChanged: (cb) => subscribe(EVENT.fullscreenChanged, (_e, isFullscreen) => cb(isFullscreen)),
    onUpdateAvailable: (cb) => subscribe(EVENT.updateAvailable, (_e, update) => cb(update)),
    onSessionWorkSnapshot: (cb) => subscribe(EVENT.sessionWorkSnapshot, (_e, snapshot) => cb(snapshot)),
    onPrStatusChanged: (cb) => subscribe(EVENT.prStatusChanged, (_e, change) => cb(change)),
    onMergeQueueChanged: (cb) => subscribe(EVENT.mergeQueueChanged, (_e, change) => cb(change)),
    onLaunchRequested: (cb) =>
        subscribe(EVENT.launchRequested, (_e, projectPath, initialPrompt) => cb(projectPath, initialPrompt)),
    onPickerRequested: (cb) =>
        subscribe(EVENT.pickerRequested, (_e, initialPrompt, reason) => cb(initialPrompt, reason)),
    onPhoneAccessChanged: (cb) => subscribe(EVENT.phoneAccessChanged, (_e, state) => cb(state)),
    onTerminalOwnerChanged: (cb) =>
        subscribe(EVENT.terminalOwnerChanged, (_e, sessionId, owner) => cb(sessionId, owner)),
    onSessionStarted: (cb) =>
        subscribe(EVENT.sessionStarted, (_e, sessionId, projectPath) => cb(sessionId, projectPath)),
    onSessionArchived: (cb) => subscribe(EVENT.sessionArchived, (_e, sessionId) => cb(sessionId)),
    onTasksChanged: (cb) => subscribe(EVENT.tasksChanged, (_e, update) => cb(update)),
    onSessionTaskChanged: (cb) => subscribe(EVENT.sessionTaskChanged, (_e, sessionId, taskId) => cb(sessionId, taskId)),
    onAgentInstallProgress: (cb) =>
        subscribe(EVENT.agentInstallProgress, (_e, projectPath, line) => cb(projectPath, line)),
    onHandoffProgress: (cb) => subscribe(EVENT.handoffProgress, (_e, localPath, line) => cb(localPath, line)),
    onBringBackProgress: (cb) => subscribe(EVENT.bringBackProgress, (_e, copyPath, line) => cb(copyPath, line)),
    onSessionHandoffPhase: (cb) => subscribe(EVENT.sessionHandoffPhase, (_e, sessionId, phase) => cb(sessionId, phase)),

    // ── Host facts ──
    getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('api', api);

// Under the e2e harness only: tells the renderer to install its test probes
// (see `features/terminal/terminal-probe`). A flag and nothing else, so no
// test-only capability is ever reachable from a normal run.
if (process.env.SWITCHBOARD_E2E === '1') contextBridge.exposeInMainWorld('switchboardE2E', true);
