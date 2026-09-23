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
import type { SwitchboardApi } from '../ipc/api';

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
  readSessionJsonl: (sessionId) => ipcRenderer.invoke(INVOKE.readSessionJsonl, sessionId),

  // ── Plans and agent files ──
  getPlans: () => ipcRenderer.invoke(INVOKE.getPlans),
  readPlan: (filename) => ipcRenderer.invoke(INVOKE.readPlan, filename),
  savePlan: (filePath, content) => ipcRenderer.invoke(INVOKE.savePlan, filePath, content),
  getMemories: () => ipcRenderer.invoke(INVOKE.getMemories),
  readMemory: (filePath) => ipcRenderer.invoke(INVOKE.readMemory, filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke(INVOKE.saveMemory, filePath, content),

  // ── Statistics ──
  getStats: () => ipcRenderer.invoke(INVOKE.getStats),
  refreshStats: () => ipcRenderer.invoke(INVOKE.refreshStats),
  getUsage: () => ipcRenderer.invoke(INVOKE.getUsage),

  // ── Search ──
  search: (type, query, titleOnly) => ipcRenderer.invoke(INVOKE.search, type, query, titleOnly),

  // ── Settings ──
  getSetting: (key) => ipcRenderer.invoke(INVOKE.getSetting, key),
  setSetting: (key, value) => ipcRenderer.invoke(INVOKE.setSetting, key, value),
  deleteSetting: (key) => ipcRenderer.invoke(INVOKE.deleteSetting, key),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke(INVOKE.getEffectiveSettings, projectPath),
  getShellProfiles: () => ipcRenderer.invoke(INVOKE.getShellProfiles),

  // ── Schedules ──
  getScheduleCreatorCommand: () => ipcRenderer.invoke(INVOKE.getScheduleCreatorCommand),
  createScheduleSession: (projectPath) => ipcRenderer.invoke(INVOKE.createScheduleSession, projectPath),
  runScheduleNow: (filePath) => ipcRenderer.invoke(INVOKE.runScheduleNow, filePath),

  // ── The viewer panel ──
  readFileForPanel: (filePath) => ipcRenderer.invoke(INVOKE.readFileForPanel, filePath),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke(INVOKE.saveFileForPanel, filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke(INVOKE.watchFile, filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke(INVOKE.unwatchFile, filePath),

  // ── Host ──
  openExternal: (url) => ipcRenderer.invoke(INVOKE.openExternal, url),
  writeClipboard: (text) => ipcRenderer.invoke(INVOKE.writeClipboard, text),
  getAppVersion: () => ipcRenderer.invoke(INVOKE.getAppVersion),
  updaterCheck: () => ipcRenderer.invoke(INVOKE.updaterCheck),
  updaterDownload: () => ipcRenderer.invoke(INVOKE.updaterDownload),
  updaterInstall: () => ipcRenderer.invoke(INVOKE.updaterInstall),

  // ── Fire-and-forget ──
  sendInput: (id, data) => ipcRenderer.send(SEND.terminalInput, id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send(SEND.terminalResize, id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send(SEND.closeTerminal, id),
  mcpDiffResponse: (sessionId, diffId, action, editedContent) =>
    ipcRenderer.send(SEND.mcpDiffResponse, sessionId, diffId, action, editedContent),

  // ── Events from main ──
  onTerminalData: (cb) => {
    ipcRenderer.on(EVENT.terminalData, (_e, sessionId, data) => cb(sessionId, data));
  },
  onProcessExited: (cb) => {
    ipcRenderer.on(EVENT.processExited, (_e, sessionId, exitCode) => cb(sessionId, exitCode));
  },
  onSessionDetected: (cb) => {
    ipcRenderer.on(EVENT.sessionDetected, (_e, tempId, realId) => cb(tempId, realId));
  },
  onSessionForked: (cb) => {
    ipcRenderer.on(EVENT.sessionForked, (_e, oldId, newId) => cb(oldId, newId));
  },
  onCliBusyState: (cb) => {
    ipcRenderer.on(EVENT.cliBusyState, (_e, sessionId, busy) => cb(sessionId, busy));
  },
  onTerminalNotification: (cb) => {
    ipcRenderer.on(EVENT.terminalNotification, (_e, sessionId, message) => cb(sessionId, message));
  },
  onRemoteStatus: (cb) => {
    ipcRenderer.on(EVENT.remoteStatus, (_e, sessionId, status) => cb(sessionId, status));
  },
  onProjectsChanged: (cb) => {
    ipcRenderer.on(EVENT.projectsChanged, () => cb());
  },
  onStatusUpdate: (cb) => {
    ipcRenderer.on(EVENT.statusUpdate, (_e, text, type) => cb(text, type));
  },
  onFullscreenChanged: (cb) => {
    ipcRenderer.on(EVENT.fullscreenChanged, (_e, isFullscreen) => cb(isFullscreen));
  },
  onFileChanged: (cb) => {
    ipcRenderer.on(EVENT.fileChanged, (_e, filePath) => cb(filePath));
  },
  onUpdaterEvent: (cb) => {
    ipcRenderer.on(EVENT.updaterEvent, (_e, type, data) => cb(type, data));
  },
  onMcpOpenDiff: (cb) => {
    ipcRenderer.on(EVENT.mcpOpenDiff, (_e, sessionId, diffId, data) => cb(sessionId, diffId, data));
  },
  onMcpOpenFile: (cb) => {
    ipcRenderer.on(EVENT.mcpOpenFile, (_e, sessionId, data) => cb(sessionId, data));
  },
  onMcpCloseAllDiffs: (cb) => {
    ipcRenderer.on(EVENT.mcpCloseAllDiffs, (_e, sessionId) => cb(sessionId));
  },
  onMcpCloseTab: (cb) => {
    ipcRenderer.on(EVENT.mcpCloseTab, (_e, sessionId, diffId) => cb(sessionId, diffId));
  },

  // ── Host facts ──
  getPathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('api', api);
