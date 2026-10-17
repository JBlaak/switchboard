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
import type { Answers, PendingQuestions, QuestionsSettled } from '../domain/questions/question';
import type { ShellProfile } from '../domain/shell/shell-profile';
import type { FileDiff, SessionWorkSnapshot } from '../domain/session-work/model';
import type { WorkingAgent } from '../domain/terminal/program-status-children';
import type { UpdateNotice } from '../domain/update/release';
import type { Usage } from '../domain/usage/usage';
import type { Weather, WeatherLocation } from '../domain/weather/weather';

/** Removes the listener an `on*` subscription added. */
export type Unsubscribe = () => void;

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

  // ── Questions ──
  /** Every set of questions a running session is blocked on, for a renderer that (re)loads. */
  getPendingQuestions(): Promise<PendingQuestions[]>;
  /** Send the answers; `{ ok: false }` when the questions were already withdrawn. */
  answerQuestions(sessionId: string, toolUseId: string, answers: Answers): Promise<IpcResult>;

  // ── Usage ──
  getUsage(): Promise<Usage | null>;

  // ── Weather ──
  /** Null when weather is switched off or could not be fetched. */
  getWeather(): Promise<Weather | null>;
  /** The best match for a city name, or null when there is none. */
  geocodeWeatherLocation(name: string): Promise<WeatherLocation | null>;

  // ── Sleep ──
  /** True when `pmset disablesleep 1` is in effect; null when it cannot be read (not a Mac). */
  getSleepDisabled(): Promise<boolean | null>;
  /** Flip the switch (may show the macOS password prompt); answers with the state read back. */
  setSleepDisabled(disabled: boolean): Promise<boolean | null>;

  // ── Updates ──
  /** A newer release waiting to be installed, or null. */
  getUpdate(): Promise<UpdateNotice | null>;
  /** Download and swap in the waiting update, then relaunch. False when it could not. */
  installUpdate(): Promise<boolean>;

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
  /** Open the project's `origin` in the browser; false when it has none with a web page. */
  openRepository(projectPath: string): Promise<boolean>;
  writeClipboard(text: string): Promise<void>;
  getAppVersion(): Promise<string>;

  // ── Session work ──
  /**
   * Open the Session work page for a session, closing whichever was open.
   * Answers the first snapshot (later ones arrive on `onSessionWorkSnapshot`),
   * or null when the page cannot open for this session.
   */
  openSessionWork(sessionId: string): Promise<SessionWorkSnapshot | null>;
  /** False for remote sessions and for sessions outside a git repository (D14). */
  canOpenSessionWork(sessionId: string): Promise<boolean>;
  /** The parsed diff of one item (`SessionWorkItem.id`) of the open page; empty when there is none. */
  getSessionWorkDiff(request: { sessionId: string; itemId: string }): Promise<FileDiff[]>;

  // ── Fire-and-forget ──
  sendInput(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  closeTerminal(id: string): void;
  /** Close the Session work page: its watchers and polling stop. */
  closeSessionWork(sessionId: string): void;

  // ── Events from main ──
  // Each answers its unsubscribe, so a listener can be removed again (StrictMode
  // mounts twice; a hot reload re-installs the bridge).
  onTerminalData(cb: (sessionId: string, data: string) => void): Unsubscribe;
  onProcessExited(cb: (sessionId: string, exitCode: number) => void): Unsubscribe;
  onSessionForked(cb: (oldId: string, newId: string) => void): Unsubscribe;
  onCliBusyState(cb: (sessionId: string, busy: boolean) => void): Unsubscribe;
  onTerminalNotification(cb: (sessionId: string, message: string) => void): Unsubscribe;
  onSessionNeedsAttention(cb: (sessionId: string) => void): Unsubscribe;
  onSessionAgents(cb: (sessionId: string, agents: WorkingAgent[]) => void): Unsubscribe;
  onRemoteStatus(cb: (sessionId: string, status: RemoteStatusPayload) => void): Unsubscribe;
  onQuestionsAsked(cb: (pending: PendingQuestions) => void): Unsubscribe;
  onQuestionsSettled(cb: (settled: QuestionsSettled) => void): Unsubscribe;
  onProjectsChanged(cb: () => void): Unsubscribe;
  onStatusUpdate(cb: (text: string, type: string) => void): Unsubscribe;
  onFullscreenChanged(cb: (isFullscreen: boolean) => void): Unsubscribe;
  onUpdateAvailable(cb: (update: UpdateNotice) => void): Unsubscribe;
  onSessionWorkSnapshot(cb: (snapshot: SessionWorkSnapshot) => void): Unsubscribe;

  // ── Host facts the renderer needs synchronously ──
  /** The absolute path of a dropped File, for drag-and-drop into a terminal. */
  getPathForFile(file: File): string;
}
