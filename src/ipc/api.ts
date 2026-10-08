/**
 * The whole contract between the main process and the renderer.
 *
 * The renderer reaches main through nothing else, and it declares `window.api`
 * against this interface — which is what makes an IPC rename a compile error
 * rather than a runtime `undefined`. The main process registers handlers named
 * from the same channel table, so the two sides cannot drift apart silently.
 */
import type { Project } from '../domain/project/project';
import type { RemoteConfig } from '../domain/project/remote-target';
import type { RemoteStatusPayload } from '../domain/remote/remote-status';
import type { SearchResult, SearchType } from '../domain/search/search';
import type { SessionOptions } from '../domain/launch/session-options';
import type { EffectiveSettings } from '../domain/settings/settings';
import type { Appearance } from '../domain/settings/appearance';
import type { ShellProfile } from '../domain/shell/shell-profile';
import type { Usage } from '../domain/usage/usage';

/** The `{ ok }`/`{ error }` envelope most handlers answer with. */
export interface IpcResult {
  ok?: boolean;
  error?: string;
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

  // ── Usage ──
  getUsage(): Promise<Usage | null>;

  // ── Search ──
  search(type: SearchType, query: string, titleOnly: boolean): Promise<SearchResult[]>;

  // ── Settings ──
  getSetting<T = unknown>(key: string): Promise<T | null>;
  setSetting(key: string, value: unknown): Promise<IpcResult>;
  getEffectiveSettings(projectPath: string | null): Promise<EffectiveSettings>;
  getShellProfiles(): Promise<ShellProfile[]>;
  /**
   * Persist the colour scheme and apply it.
   *
   * A channel of its own rather than `setSetting`: storing the value is only
   * half of it, main also has to hand it to Electron.
   */
  setAppearance(mode: Appearance): Promise<IpcResult>;

  // ── Host ──
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  getAppVersion(): Promise<string>;

  // ── Fire-and-forget ──
  sendInput(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  closeTerminal(id: string): void;

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

  // ── Host facts the renderer needs synchronously ──
  /** The absolute path of a dropped File, for drag-and-drop into a terminal. */
  getPathForFile(file: File): string;
  platform: NodeJS.Platform;
}
