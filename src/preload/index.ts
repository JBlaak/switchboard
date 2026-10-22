/**
 * The context-isolation bridge.
 *
 * Nothing but wiring: every method forwards to a channel from the shared table,
 * and the shape it forwards is the shared contract. The renderer runs with
 * nodeIntegration off, so this is the only surface it has — which is why it
 * stays a flat, auditable list rather than exposing `ipcRenderer` itself.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENT, INVOKE, SEND } from '../ipc/channels';
import type { SwitchboardApi, Unsubscribe } from '../ipc/api';

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
  return () => { ipcRenderer.removeListener(channel, listener); };
}

const api: SwitchboardApi = {
  // ── Projects ──
  getProjects: (showArchived) => ipcRenderer.invoke(INVOKE.getProjects, showArchived),
  browseFolder: () => ipcRenderer.invoke(INVOKE.browseFolder),
  addProject: (projectPath) => ipcRenderer.invoke(INVOKE.addProject, projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke(INVOKE.removeProject, projectPath),
  addRemoteProject: (config) => ipcRenderer.invoke(INVOKE.addRemoteProject, config),
  removeRemoteProject: (projectPath) => ipcRenderer.invoke(INVOKE.removeRemoteProject, projectPath),

  // ── Sessions ──
  getActiveSessions: () => ipcRenderer.invoke(INVOKE.getActiveSessions),
  getActiveTerminals: () => ipcRenderer.invoke(INVOKE.getActiveTerminals),
  openTerminal: (id, projectPath, isNew, sessionOptions) =>
    ipcRenderer.invoke(INVOKE.openTerminal, id, projectPath, isNew, sessionOptions),
  stopSession: (id) => ipcRenderer.invoke(INVOKE.stopSession, id),
  reconnectRemote: (id) => ipcRenderer.invoke(INVOKE.reconnectRemote, id),
  toggleStar: (id) => ipcRenderer.invoke(INVOKE.toggleStar, id),
  renameSession: (id, name) => ipcRenderer.invoke(INVOKE.renameSession, id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke(INVOKE.archiveSession, id, archived),

  // ── Questions ──
  getPendingQuestions: () => ipcRenderer.invoke(INVOKE.getPendingQuestions),
  answerQuestions: (sessionId, toolUseId, answers) =>
    ipcRenderer.invoke(INVOKE.answerQuestions, sessionId, toolUseId, answers),

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

  // ── Plan: sessions on a plan's issues (#125) ──
  issueSessions: (repository) => ipcRenderer.invoke(INVOKE.planIssueSessions, repository),
  prepareIssueWorktree: (request) => ipcRenderer.invoke(INVOKE.planPrepareIssueWorktree, request),
  // ── Plans (#123) ──
  sessionPlans: (sessionId) => ipcRenderer.invoke(INVOKE.planSessionPlans, sessionId),
  plan: (repo, number) => ipcRenderer.invoke(INVOKE.planGet, repo, number),
  projectPlans: (projectPath, options) => ipcRenderer.invoke(INVOKE.planProjectPlans, projectPath, options),
  // ── The project page (#172) ──
  projectOverview: (projectPath, options) => ipcRenderer.invoke(INVOKE.projectOverview, projectPath, options),

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
  onTerminalNotification: (cb) => subscribe(EVENT.terminalNotification, (_e, sessionId, message) => cb(sessionId, message)),
  onSessionNeedsAttention: (cb) => subscribe(EVENT.sessionNeedsAttention, (_e, sessionId) => cb(sessionId)),
  onSessionAgents: (cb) => subscribe(EVENT.sessionAgents, (_e, sessionId, agents) => cb(sessionId, agents)),
  onRemoteStatus: (cb) => subscribe(EVENT.remoteStatus, (_e, sessionId, status) => cb(sessionId, status)),
  onQuestionsAsked: (cb) => subscribe(EVENT.questionsAsked, (_e, pending) => cb(pending)),
  onQuestionsSettled: (cb) => subscribe(EVENT.questionsSettled, (_e, settled) => cb(settled)),
  onProjectsChanged: (cb) => subscribe(EVENT.projectsChanged, () => cb()),
  onStatusUpdate: (cb) => subscribe(EVENT.statusUpdate, (_e, text, type) => cb(text, type)),
  onFullscreenChanged: (cb) => subscribe(EVENT.fullscreenChanged, (_e, isFullscreen) => cb(isFullscreen)),
  onUpdateAvailable: (cb) => subscribe(EVENT.updateAvailable, (_e, update) => cb(update)),
  onSessionWorkSnapshot: (cb) => subscribe(EVENT.sessionWorkSnapshot, (_e, snapshot) => cb(snapshot)),
  onPrStatusChanged: (cb) => subscribe(EVENT.prStatusChanged, (_e, change) => cb(change)),
  onLaunchRequested: (cb) => subscribe(EVENT.launchRequested, (_e, projectPath, initialPrompt) => cb(projectPath, initialPrompt)),
  onPickerRequested: (cb) => subscribe(EVENT.pickerRequested, (_e, initialPrompt, reason) => cb(initialPrompt, reason)),

  // ── Host facts ──
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('api', api);

// Under the e2e harness only: tells the renderer to install its test probes
// (see `features/terminal/terminal-probe`). A flag and nothing else, so no
// test-only capability is ever reachable from a normal run.
if (process.env.SWITCHBOARD_E2E === '1') contextBridge.exposeInMainWorld('switchboardE2E', true);
