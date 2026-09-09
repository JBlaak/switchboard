/**
 * The whole contract between the main process and the renderer.
 *
 * The renderer reaches main through nothing else, and it declares `window.api`
 * against this interface — which is what makes an IPC rename a compile error
 * rather than a runtime `undefined`. The main process registers handlers named
 * from the same channel table, so the two sides cannot drift apart silently.
 */
import type { AgentFileIndex } from '../domain/agent-files/agent-file';
import type { BrowseFile, BrowseListing } from '../domain/browse/types';
import type { Worktree } from '../domain/git/types';
import type { PlanSummary } from '../domain/plans/plan';
import type { Project } from '../domain/project/project';
import type { RemoteConfig } from '../domain/project/remote-target';
import type { RemoteStatusPayload } from '../domain/remote/remote-status';
import type { SearchResult, SearchType } from '../domain/search/search';
import type { SessionOptions } from '../domain/launch/session-options';
import type { EffectiveSettings } from '../domain/settings/settings';
import type { ShellProfile } from '../domain/shell/shell-profile';
import type { TranscriptEntry } from '../domain/session/transcript';
import type { StatsData } from '../domain/stats/stats';
import type { Usage } from '../domain/usage/usage';
import type { DiffRequest, FileOpenRequest } from '../domain/ide/ide-request';

/** The `{ ok }`/`{ error }` envelope most handlers answer with. */
export interface IpcResult {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

/** electron-updater's event payload, as far as the UI reads it. */
export interface UpdaterEventData {
  version?: string;
  percent?: number;
  message?: string;
  releaseName?: string;
  [key: string]: unknown;
}

export interface SwitchboardApi {
  // ── Projects ──
  getProjects(showArchived: boolean): Promise<Project[]>;
  browseFolder(): Promise<string | null>;
  addProject(projectPath: string): Promise<IpcResult>;
  removeProject(projectPath: string): Promise<IpcResult>;
  addRemoteProject(config: Partial<RemoteConfig>): Promise<IpcResult>;
  removeRemoteProject(projectPath: string): Promise<IpcResult>;

  // ── Sessions ──
  getActiveSessions(): Promise<string[]>;
  getActiveTerminals(): Promise<{ sessionId: string; projectPath: string }[]>;
  openTerminal(
    id: string, projectPath: string, isNew: boolean, sessionOptions?: SessionOptions,
  ): Promise<IpcResult>;
  stopSession(id: string): Promise<IpcResult>;
  reconnectRemote(id: string): Promise<IpcResult>;
  toggleStar(id: string): Promise<{ starred: number }>;
  /** `null` clears the rename, falling back to the AI/first-prompt title. */
  renameSession(id: string, name: string | null): Promise<IpcResult>;
  archiveSession(id: string, archived: boolean): Promise<{ archived: number }>;
  readSessionJsonl(sessionId: string): Promise<{ entries?: TranscriptEntry[]; error?: string }>;

  // ── Plans and agent files ──
  getPlans(): Promise<PlanSummary[]>;
  readPlan(filename: string): Promise<{ content: string; filePath: string }>;
  savePlan(filePath: string, content: string): Promise<IpcResult>;
  getMemories(): Promise<AgentFileIndex>;
  readMemory(filePath: string): Promise<string | null>;
  saveMemory(filePath: string, content: string): Promise<IpcResult>;

  // ── Statistics ──
  getStats(): Promise<StatsData | null>;
  refreshStats(): Promise<{ stats?: StatsData | null; usage?: Usage } | null>;
  getUsage(): Promise<Usage | null>;

  // ── Search ──
  search(type: SearchType, query: string, titleOnly: boolean): Promise<SearchResult[]>;

  // ── Settings ──
  getSetting<T = unknown>(key: string): Promise<T | null>;
  setSetting(key: string, value: unknown): Promise<IpcResult>;
  deleteSetting(key: string): Promise<IpcResult>;
  getEffectiveSettings(projectPath: string | null): Promise<EffectiveSettings>;
  getShellProfiles(): Promise<ShellProfile[]>;

  // ── Schedules ──
  getScheduleCreatorCommand(): Promise<string | null>;
  createScheduleSession(projectPath: string): Promise<{ sessionId: string; systemPrompt: string } | null>;
  runScheduleNow(filePath: string): Promise<IpcResult>;

  // ── The viewer panel ──
  readFileForPanel(filePath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  saveFileForPanel(filePath: string, content: string): Promise<IpcResult>;
  watchFile(filePath: string): Promise<IpcResult>;
  unwatchFile(filePath: string): Promise<IpcResult>;

  // ── Git ──
  /**
   * `[]` for a folder that is not a repository. A failure answers with the
   * `{ ok: false, error }` envelope, as every invoke does — check for an array.
   */
  gitWorktrees(projectPath: string): Promise<Worktree[]>;

  // ── Browsing a worktree ──
  /**
   * One level of the file tree: the direct children of `relPath` inside
   * `worktreePath` (`''` for the worktree itself), ignored names already
   * dropped, directories first. A folder that cannot be read answers
   * `{ entries: [], unreadable: true }`; only a path that tries to leave the
   * worktree fails, with the `{ ok: false, error }` envelope — so check that
   * `entries` is an array before walking it.
   */
  listDir(worktreePath: string, relPath: string): Promise<BrowseListing>;
  /**
   * One file inside the worktree. `error` instead of `content` when it cannot
   * be read or is too large to send; `readOnly` when there is no way to write
   * it back, which is every remote project.
   */
  readProjectFile(worktreePath: string, relPath: string): Promise<BrowseFile>;

  // ── Host ──
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  getAppVersion(): Promise<string>;
  updaterCheck(): Promise<IpcResult>;
  updaterDownload(): Promise<IpcResult>;
  updaterInstall(): Promise<IpcResult>;

  // ── Fire-and-forget ──
  sendInput(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  closeTerminal(id: string): void;
  mcpDiffResponse(
    sessionId: string, diffId: string, action: string, editedContent: string | null,
  ): void;

  // ── Events from main ──
  onTerminalData(cb: (sessionId: string, data: string) => void): void;
  onProcessExited(cb: (sessionId: string, exitCode: number) => void): void;
  onSessionDetected(cb: (tempId: string, realId: string) => void): void;
  onSessionForked(cb: (oldId: string, newId: string) => void): void;
  onCliBusyState(cb: (sessionId: string, busy: boolean) => void): void;
  onTerminalNotification(cb: (sessionId: string, message: string) => void): void;
  onRemoteStatus(cb: (sessionId: string, status: RemoteStatusPayload) => void): void;
  onProjectsChanged(cb: () => void): void;
  onStatusUpdate(cb: (text: string, type: string) => void): void;
  onFullscreenChanged(cb: (isFullscreen: boolean) => void): void;
  onFileChanged(cb: (filePath: string) => void): void;
  onUpdaterEvent(cb: (type: string, data: UpdaterEventData) => void): void;
  onMcpOpenDiff(cb: (sessionId: string, diffId: string, data: DiffRequest) => void): void;
  onMcpOpenFile(cb: (sessionId: string, data: FileOpenRequest) => void): void;
  onMcpCloseAllDiffs(cb: (sessionId: string) => void): void;
  onMcpCloseTab(cb: (sessionId: string, diffId: string) => void): void;

  // ── Host facts the renderer needs synchronously ──
  /** The absolute path of a dropped File, for drag-and-drop into a terminal. */
  getPathForFile(file: File): string;
  platform: NodeJS.Platform;
}
