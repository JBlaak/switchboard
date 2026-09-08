/**
 * The context-isolation bridge.
 *
 * `SwitchboardApi` below is the whole contract between main and renderer — the
 * renderer reaches main through nothing else. It is exported so the renderer can
 * declare `window.api` against it (see src/renderer/global.d.ts), which is what
 * makes an IPC channel rename a compile error rather than a runtime `undefined`.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  Project, RemoteConfig, RemoteStatusPayload, SearchResult, SearchType, SessionOptions,
} from '../shared/types.js';

/** The `{ ok }`/`{ error }` envelope most main handlers answer with. */
export interface IpcResult {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface PlanSummary {
  filename: string;
  title: string;
  modified: string;
}

/** One agent-file (CLAUDE.md, a schedule, …) as the memory tab lists it. */
export interface MemoryFile {
  filename: string;
  filePath: string;
  modified: string;
  displayPath?: string;
  [key: string]: unknown;
}

/** The memory tab's contents: the global files plus one group per project. */
export interface MemoryData {
  global: { files: MemoryFile[] };
  projects: { folder: string; shortName: string; files: MemoryFile[] }[];
}

/** An MCP-initiated diff, as the file panel receives it. */
/**
 * The `/stats` cache and the usage summary.
 *
 * Both come from the Claude CLI (one parsed out of its `/stats` output, one from
 * the OAuth usage endpoint), so their shape is the CLI's to change. Left open
 * rather than pinned to a schema that would silently drift.
 */
export type StatsData = Record<string, any>;
export type UsageData = Record<string, any>;

/** electron-updater's event payload, as far as the UI reads it. */
export interface UpdaterEventData {
  version?: string;
  percent?: number;
  message?: string;
  releaseName?: string;
  [key: string]: unknown;
}

/**
 * A project's settings with global defaults already applied.
 *
 * Mirrors SETTING_DEFAULTS in the main process; the index signature covers keys
 * a newer build writes that this one does not know about yet.
 */
export interface EffectiveSettings {
  permissionMode?: string | null;
  dangerouslySkipPermissions?: boolean;
  worktree?: boolean;
  worktreeName?: string;
  chrome?: boolean;
  preLaunchCmd?: string;
  addDirs?: string;
  visibleSessionCount?: number;
  sidebarWidth?: number;
  terminalTheme?: string;
  terminalFontFamily?: string;
  terminalFontSize?: number;
  terminalLineHeight?: number;
  mcpEmulation?: boolean;
  shellProfile?: string;
  [key: string]: unknown;
}

export interface McpDiffPayload {
  oldFilePath: string;
  oldContent: string;
  newContent: string;
  tabName: string;
}

export interface McpFilePayload {
  filePath: string;
  content: string;
  preview: boolean;
  startText: string;
  endText: string;
}

export interface SwitchboardApi {
  // Invoke (request-response)
  getPlans(): Promise<PlanSummary[]>;
  readPlan(filename: string): Promise<{ content: string; filePath: string }>;
  savePlan(filePath: string, content: string): Promise<IpcResult>;
  getStats(): Promise<StatsData | null>;
  refreshStats(): Promise<{ stats?: StatsData; usage?: UsageData } | null>;
  getUsage(): Promise<UsageData | null>;
  getMemories(): Promise<MemoryData>;
  readMemory(filePath: string): Promise<string | null>;
  saveMemory(filePath: string, content: string): Promise<IpcResult>;
  getProjects(showArchived: boolean): Promise<Project[]>;
  getActiveSessions(): Promise<string[]>;
  getActiveTerminals(): Promise<{ sessionId: string; projectPath: string }[]>;
  stopSession(id: string): Promise<IpcResult>;
  reconnectRemote(id: string): Promise<IpcResult>;
  toggleStar(id: string): Promise<{ starred: number }>;
  /** `null` clears the rename, falling back to the AI/first-prompt title. */
  renameSession(id: string, name: string | null): Promise<IpcResult>;
  archiveSession(id: string, archived: boolean): Promise<{ archived: number }>;
  openTerminal(
    id: string, projectPath: string, isNew: boolean, sessionOptions?: SessionOptions,
  ): Promise<IpcResult>;
  search(type: SearchType, query: string, titleOnly: boolean): Promise<SearchResult[]>;
  readSessionJsonl(sessionId: string): Promise<{ entries?: unknown[]; error?: string }>;

  // Settings
  getSetting<T = unknown>(key: string): Promise<T | null>;
  setSetting(key: string, value: unknown): Promise<IpcResult>;
  deleteSetting(key: string): Promise<IpcResult>;
  getEffectiveSettings(projectPath: string | null): Promise<EffectiveSettings>;
  getScheduleCreatorCommand(): Promise<string | null>;
  createScheduleSession(projectPath: string): Promise<{ sessionId: string; systemPrompt: string } | null>;
  runScheduleNow(filePath: string): Promise<IpcResult>;
  getShellProfiles(): Promise<{ id: string; name: string; path: string; args?: string[] }[]>;

  browseFolder(): Promise<string | null>;
  addProject(projectPath: string): Promise<IpcResult>;
  removeProject(projectPath: string): Promise<IpcResult>;
  addRemoteProject(config: Partial<RemoteConfig>): Promise<IpcResult>;
  removeRemoteProject(projectPath: string): Promise<IpcResult>;
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;

  // Send (fire-and-forget)
  sendInput(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  closeTerminal(id: string): void;

  // Listeners (main → renderer)
  onTerminalData(cb: (sessionId: string, data: string) => void): void;
  onSessionDetected(cb: (tempId: string, realId: string) => void): void;
  onProcessExited(cb: (sessionId: string, exitCode: number) => void): void;
  onRemoteStatus(cb: (sessionId: string, status: RemoteStatusPayload) => void): void;
  onTerminalNotification(cb: (sessionId: string, message: string) => void): void;
  onCliBusyState(cb: (sessionId: string, busy: boolean) => void): void;
  onSessionForked(cb: (oldId: string, newId: string) => void): void;
  onProjectsChanged(cb: () => void): void;
  onStatusUpdate(cb: (text: string, type: string) => void): void;
  onFullscreenChanged(cb: (isFullscreen: boolean) => void): void;

  // File drag-and-drop
  getPathForFile(file: File): string;

  // Platform
  platform: NodeJS.Platform;

  // App version
  getAppVersion(): Promise<string>;

  // Auto-updater
  updaterCheck(): Promise<IpcResult>;
  updaterDownload(): Promise<IpcResult>;
  updaterInstall(): Promise<IpcResult>;
  onUpdaterEvent(cb: (type: string, data: UpdaterEventData) => void): void;

  // MCP bridge (main → renderer)
  onMcpOpenDiff(cb: (sessionId: string, diffId: string, data: McpDiffPayload) => void): void;
  onMcpOpenFile(cb: (sessionId: string, data: McpFilePayload) => void): void;
  onMcpCloseAllDiffs(cb: (sessionId: string) => void): void;
  onMcpCloseTab(cb: (sessionId: string, diffId: string) => void): void;

  // MCP bridge (renderer → main)
  mcpDiffResponse(
    sessionId: string, diffId: string, action: string, editedContent: string | null,
  ): void;
  readFileForPanel(filePath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  saveFileForPanel(filePath: string, content: string): Promise<IpcResult>;
  watchFile(filePath: string): Promise<IpcResult>;
  unwatchFile(filePath: string): Promise<IpcResult>;
  onFileChanged(cb: (filePath: string) => void): void;
}

const api: SwitchboardApi = {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  reconnectRemote: (id) => ipcRenderer.invoke('reconnect-remote', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getScheduleCreatorCommand: () => ipcRenderer.invoke('get-schedule-creator-command'),
  createScheduleSession: (projectPath) => ipcRenderer.invoke('create-schedule-session', projectPath),
  runScheduleNow: (filePath) => ipcRenderer.invoke('run-schedule-now', filePath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),
  addRemoteProject: (config) => ipcRenderer.invoke('add-remote-project', config),
  removeRemoteProject: (projectPath) => ipcRenderer.invoke('remove-remote-project', projectPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', text),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),

  // Listeners (main → renderer)
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode) => callback(sessionId, exitCode));
  },
  onRemoteStatus: (callback) => {
    ipcRenderer.on('remote-status', (_event, sessionId, status) => callback(sessionId, status));
  },
  onTerminalNotification: (callback) => {
    ipcRenderer.on('terminal-notification', (_event, sessionId, message) => callback(sessionId, message));
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
  },
  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', () => callback());
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },
  onFullscreenChanged: (callback) => {
    ipcRenderer.on('fullscreen-changed', (_event, isFullscreen) => callback(isFullscreen));
  },

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterEvent: (callback) => {
    ipcRenderer.on('updater-event', (_event, type, data) => callback(type, data));
  },

  // MCP bridge (main → renderer)
  onMcpOpenDiff: (callback) => {
    ipcRenderer.on('mcp-open-diff', (_event, sessionId, diffId, data) => callback(sessionId, diffId, data));
  },
  onMcpOpenFile: (callback) => {
    ipcRenderer.on('mcp-open-file', (_event, sessionId, data) => callback(sessionId, data));
  },
  onMcpCloseAllDiffs: (callback) => {
    ipcRenderer.on('mcp-close-all-diffs', (_event, sessionId) => callback(sessionId));
  },
  onMcpCloseTab: (callback) => {
    ipcRenderer.on('mcp-close-tab', (_event, sessionId, diffId) => callback(sessionId, diffId));
  },

  // MCP bridge (renderer → main)
  mcpDiffResponse: (sessionId, diffId, action, editedContent) => {
    ipcRenderer.send('mcp-diff-response', sessionId, diffId, action, editedContent);
  },
  readFileForPanel: (filePath) => ipcRenderer.invoke('read-file-for-panel', filePath),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (_event, filePath) => callback(filePath));
  },
};

contextBridge.exposeInMainWorld('api', api);
