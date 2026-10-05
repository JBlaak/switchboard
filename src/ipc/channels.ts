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

  // Usage
  getUsage: 'get-usage',

  // Search
  search: 'search',

  // Settings
  getSetting: 'get-setting',
  setSetting: 'set-setting',
  deleteSetting: 'delete-setting',
  getEffectiveSettings: 'get-effective-settings',
  getShellProfiles: 'get-shell-profiles',

  // Schedules
  getScheduleCreatorCommand: 'get-schedule-creator-command',
  createScheduleSession: 'create-schedule-session',
  runScheduleNow: 'run-schedule-now',


  // Host
  openExternal: 'open-external',
  writeClipboard: 'clipboard-write-text',
  getAppVersion: 'get-app-version',
  updaterCheck: 'updater-check',
  updaterDownload: 'updater-download',
  updaterInstall: 'updater-install',
} as const;

/** Renderer tells main; no answer expected. */
export const SEND = {
  terminalInput: 'terminal-input',
  terminalResize: 'terminal-resize',
  closeTerminal: 'close-terminal',
} as const;

/** Main tells the renderer, unprompted. */
export const EVENT = {
  terminalData: 'terminal-data',
  processExited: 'process-exited',
  sessionDetected: 'session-detected',
  sessionForked: 'session-forked',
  cliBusyState: 'cli-busy-state',
  terminalNotification: 'terminal-notification',
  remoteStatus: 'remote-status',
  projectsChanged: 'projects-changed',
  statusUpdate: 'status-update',
  fullscreenChanged: 'fullscreen-changed',
  updaterEvent: 'updater-event',
} as const;
