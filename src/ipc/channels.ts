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

  // Sessions
  getActiveSessions: 'get-active-sessions',
  getActiveTerminals: 'get-active-terminals',
  openTerminal: 'open-terminal',
  stopSession: 'stop-session',
  reconnectRemote: 'reconnect-remote',
  toggleStar: 'toggle-star',
  renameSession: 'rename-session',
  archiveSession: 'archive-session',

  // Questions
  getPendingQuestions: 'get-pending-questions',
  answerQuestions: 'answer-questions',

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

  // Search
  search: 'search',

  // Settings
  getSetting: 'get-setting',
  setSetting: 'set-setting',
  getEffectiveSettings: 'get-effective-settings',
  getShellProfiles: 'get-shell-profiles',
  setAppearance: 'set-appearance',
  quickAskHotkeyStatus: 'quick-ask:hotkey-status',

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
  sessionWorkDiff: 'session-work:diff',
  sessionWorkImage: 'session-work:image',
  sessionWorkAction: 'session-work:action',
  sessionWorkCancel: 'session-work:cancel',
  sessionWorkComment: 'session-work:comment',
  sessionWorkReview: 'session-work:review',
  sessionWorkCheckLog: 'session-work:check-log',

  // Plan: sessions on a plan's issues (#125)
  planIssueSessions: 'plan:issue-sessions',
  planPrepareIssueWorktree: 'plan:prepare-issue-worktree',
  // Plans (#123)
  planSessionPlans: 'plan:session-plans',
  planGet: 'plan:get',
  planProjectPlans: 'plan:project-plans',
  // The project page (#172)
  projectOverview: 'project:overview',
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
  remoteStatus: 'remote-status',
  questionsAsked: 'questions-asked',
  questionsSettled: 'questions-settled',
  projectsChanged: 'projects-changed',
  statusUpdate: 'status-update',
  fullscreenChanged: 'fullscreen-changed',
  updateAvailable: 'update-available',
  sessionWorkSnapshot: 'session-work:snapshot',
  prStatusChanged: 'pr-status:changed',
  launchRequested: 'quick-ask:launch-requested',
  pickerRequested: 'quick-ask:picker-requested',
} as const;

/** Main tells the Quick Ask pop-up, unprompted; it is a window of its own (#142). */
export const QUICK_ASK_EVENT = {
  shown: 'quick-ask:shown',
  closeRequested: 'quick-ask:close-requested',
  saving: 'quick-ask:saving',
} as const;
