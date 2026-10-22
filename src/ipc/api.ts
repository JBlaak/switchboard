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
import type { ProjectFolderCheck } from '../domain/project/folder-check';
import type { RemoteStatusPayload } from '../domain/remote/remote-status';
import type { SearchResult, SearchType } from '../domain/search/search';
import type { SessionOptions } from '../domain/launch/session-options';
import type { EffectiveSettings } from '../domain/settings/settings';
import type { Appearance } from '../domain/settings/appearance';
import type { Answers, PendingQuestions, QuestionsSettled } from '../domain/questions/question';
import type { ShellProfile } from '../domain/shell/shell-profile';
import type { SessionWorkDiff, SessionWorkSnapshot } from '../domain/session-work/model';
import type { PullRequestStatusChange } from '../domain/session-work/status';
import type { ActionRequest, ActionResult, CancelResult } from '../domain/session-work/actions';
import type { CommentRequest, ReviewRequest, ReviewResult } from '../domain/session-work/review';
import type { WorkingAgent } from '../domain/terminal/program-status-children';
import type { UpdateNotice } from '../domain/update/release';
import type { Usage } from '../domain/usage/usage';
import type { Weather, WeatherLocation } from '../domain/weather/weather';
import type { CaptureTarget, RouteRequest, RouteResult } from '../domain/ask/model';
import type { IssueWorktreeRequest, IssueWorktreeResult } from '../domain/plan/issue-session';
import type { Plan, PlanSummary } from '../domain/plan/model';

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
  /**
   * What adding the typed path would add: whether it is there, a repository,
   * on GitHub, and how far Tab completes it. A leading `~` is expanded.
   */
  checkProjectFolder(typed: string): Promise<ProjectFolderCheck>;

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

  // ── Ask Patch ──
  /**
   * Which project the user's text is about, and the prompt to start it on.
   * Never rejects: a failed call answers `{ kind: 'failed' }`.
   */
  askRoute(request: RouteRequest): Promise<RouteResult>;
  /** Stop the request in flight; it then answers `{ kind: 'cancelled' }`. */
  cancelAskRoute(): Promise<void>;
  /** Start a `claude` process for the next request now, so it answers sooner; one at a time. */
  warmAskRoute(): Promise<void>;

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
  /**
   * Whether main holds ⌥Space for Quick Ask, false when it is off or another
   * app has it; and the capture targets whose server isn't set up in Claude Code.
   */
  quickAskHotkeyStatus(): Promise<{ registered: boolean; missing: CaptureTarget[] }>;

  // ── Host ──
  openExternal(url: string): Promise<void>;
  /** Open the project's `origin` in the browser; false when it has none with a web page. */
  openRepository(projectPath: string): Promise<boolean>;
  writeClipboard(text: string): Promise<void>;
  /** Copy a PNG to the clipboard. */
  writeClipboardImage(png: Uint8Array): Promise<void>;
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
  /** The parsed diff of one item (`SessionWorkItem.id`) of the open page, and where it came from. */
  getSessionWorkDiff(request: { sessionId: string; itemId: string }): Promise<SessionWorkDiff>;
  /**
   * One side of an image (`FileDiff.image`) in an item's local diff, as bytes;
   * null when there is none. Only a file in that diff can be named, and it is
   * read at the commits the diff was made from (L3).
   */
  sessionWorkImage(request: { sessionId: string; itemId: string; path: string; side: 'before' | 'after' }): Promise<Uint8Array | null>;
  /**
   * Hand an item of the open page to Claude: its prompt is queued and typed
   * into the session's terminal once it is idle. Refused, with the reason,
   * when the session is not running or the item cannot take the action.
   */
  sessionWorkAction(request: ActionRequest): Promise<ActionResult>;
  /** Take a queued action back out of its queue; one already typed in cannot be. */
  cancelSessionWorkAction(activityId: string): Promise<CancelResult>;
  /** Add a line comment to your pending review on a PR item, starting the review if there is none (C1, C2). */
  sessionWorkComment(request: CommentRequest): Promise<ReviewResult>;
  /** Finish your pending review on a PR item: submit it (and hand its threads to Claude), or discard it (C2). */
  sessionWorkReview(request: ReviewRequest): Promise<ReviewResult>
  /** The end of a failing check run's log, for the Checks panel; null when `gh` has none. */
  getCheckLog(request: { repository: string; checkRunUrl: string }): Promise<string | null>;

  // ── Plan: sessions on a plan's issues (#125) ──
  /** `owner/repo#n` → the id of the session that owns it (S1), across the repository's sessions. */
  issueSessions(repository: string): Promise<Record<string, string>>;
  /**
   * Make the worktree a new session on a plan's issue starts in (A2, A3),
   * answering it and the prompt Claude starts with. The renderer starts the
   * session (`startIssueSession`), because the row is its to make.
   */
  prepareIssueWorktree(request: IssueWorktreeRequest): Promise<IssueWorktreeResult>;
  // ── Plans (#123) ──
  // Each answer is kept for 30 s in main, so polling is cheap. Null when `gh`
  // could not be asked, or the session or project is not a GitHub repository.
  /** The plans a session works on (W2, S1), and its repository's open plans as `others` (W3). */
  sessionPlans(sessionId: string): Promise<{ plans: Plan[]; others: PlanSummary[] } | null>;
  /** One plan by its issue, for the Plan view without a session (F2). */
  plan(repo: string, number: number): Promise<Plan | null>;
  /** A project's plans for the picker (F1): open ones, and closed ones too with `closed` (F3). */
  projectPlans(projectPath: string, options: { closed: boolean }): Promise<PlanSummary[] | null>;

  // ── Fire-and-forget ──
  sendInput(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  closeTerminal(id: string): void;
  /** Close the Session work page: its watchers and polling stop. */
  closeSessionWork(sessionId: string): void;
  /** Move the window by hand from the sidebar's blank space (see `ElectronWindowDrag`). */
  startWindowDrag(): void;
  /** How far the pointer has come since the drag started, in screen points. */
  moveWindowDrag(dx: number, dy: number): void;
  endWindowDrag(): void;
  /** How many sessions are in the Needs input block; the dock bounces when it rises. */
  setNeedsInputCount(count: number): void;
  /**
   * The projects are loaded and the view restored: main may send what it held
   * for a window it opened (Quick Ask, R4).
   */
  rendererReady(): void;

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
  /** A running session's PR chips changed colour (W4). */
  onPrStatusChanged(cb: (change: PullRequestStatusChange) => void): Unsubscribe;
  /** Quick Ask: start a Claude session there on this prompt (R3). */
  onLaunchRequested(cb: (projectPath: string, initialPrompt: string) => void): Unsubscribe;
  /** Quick Ask: open the New Session picker holding this prompt; `reason` is Patch's line. */
  onPickerRequested(cb: (initialPrompt: string, reason?: string) => void): Unsubscribe;

  // ── Host facts the renderer needs synchronously ──
  /** The absolute path of a dropped File, for drag-and-drop into a terminal. */
  getPathForFile(file: File): string;
}
