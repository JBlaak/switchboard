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

  // Host
  openExternal: 'open-external',
  openRepository: 'open-repository',
  writeClipboard: 'clipboard-write-text',
  getAppVersion: 'get-app-version',

  // Session work
  sessionWorkOpen: 'session-work:open',
  sessionWorkCanOpen: 'session-work:can-open',
  sessionWorkDiff: 'session-work:diff',
  sessionWorkAction: 'session-work:action',
  sessionWorkCancel: 'session-work:cancel',
  sessionWorkComment: 'session-work:comment',
  sessionWorkReview: 'session-work:review',
  sessionWorkCheckLog: 'session-work:check-log',
} as const;

/** Renderer tells main; no answer expected. */
export const SEND = {
  terminalInput: 'terminal-input',
  terminalResize: 'terminal-resize',
  closeTerminal: 'close-terminal',
  sessionWorkClose: 'session-work:close',
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
} as const;
