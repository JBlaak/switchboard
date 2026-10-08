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

  // ── Usage ──
  getUsage: () => ipcRenderer.invoke(INVOKE.getUsage),

  // ── Search ──
  search: (type, query, titleOnly) => ipcRenderer.invoke(INVOKE.search, type, query, titleOnly),

  // ── Settings ──
  getSetting: (key) => ipcRenderer.invoke(INVOKE.getSetting, key),
  setSetting: (key, value) => ipcRenderer.invoke(INVOKE.setSetting, key, value),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke(INVOKE.getEffectiveSettings, projectPath),
  getShellProfiles: () => ipcRenderer.invoke(INVOKE.getShellProfiles),
  setAppearance: (mode) => ipcRenderer.invoke(INVOKE.setAppearance, mode),

  // ── Host ──
  openExternal: (url) => ipcRenderer.invoke(INVOKE.openExternal, url),
  writeClipboard: (text) => ipcRenderer.invoke(INVOKE.writeClipboard, text),
  getAppVersion: () => ipcRenderer.invoke(INVOKE.getAppVersion),

  // ── Fire-and-forget ──
  sendInput: (id, data) => ipcRenderer.send(SEND.terminalInput, id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send(SEND.terminalResize, id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send(SEND.closeTerminal, id),

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

  // ── Host facts ──
  getPathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('api', api);
