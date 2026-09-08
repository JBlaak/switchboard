const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');

// SWITCHBOARD_DATA_DIR isolates a dev/test instance from the installed app:
// db.js puts switchboard.db under it, and pointing userData there gives the
// instance its own single-instance lock (requestSingleInstanceLock keys on
// userData), so both can run side by side.
if (process.env.SWITCHBOARD_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.SWITCHBOARD_DATA_DIR, 'electron'));
}

log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction.
const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION'
  )
);

// Ending a session → session-stop.js
const {
  init: initSessionStop, isPtyAlive, signalSessionTree, retireSession,
  stopSessionTree, findActiveSession,
} = require('./session-stop');
// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgvForShell } = require('./shell-profiles');
const { startScheduler } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');
const {
  isRemoteProjectPath, remoteProjectPath, parseRemoteProjectPath, normalizeRemoteDir,
  validateRemoteInput, buildSshArgv, buildSshSpawn,
  remoteRetryDelay, isRetryableSshExit, isFatalSshOutput, outputProvesRemoteIsLive, describeSshExit,
  MAX_RETRIES: REMOTE_MAX_RETRIES,
} = require('./remote-projects');


// --- Auto-updater (only in packaged builds) ---
let autoUpdater = null;
if (app.isPackaged || process.env.FORCE_UPDATER) {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  function sendUpdaterEvent(type, data) {
    log.info(`[updater] ${type}`, data || '');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', type, data);
    }
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => sendUpdaterEvent('update-available', info));
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('update-not-available', info));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('download-progress', progress));
  autoUpdater.on('update-downloaded', (info) => sendUpdaterEvent('update-downloaded', info));
  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err?.message || String(err));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', 'error', { message: err?.message || String(err) });
    }
  });
}
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  closeDb,
} = require('./db');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE = 256 * 1024;

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;

initSessionStop({
  activeSessions, getMainWindow: () => mainWindow, log, shutdownMcpServer,
});

// Sidebar background — the window controls sit over the sidebar, so the overlay on
// Windows/Linux has to be painted the same colour or it shows as a lighter block.
// Kept in sync with --sb-bg-panel / --sb-text-muted in style.css.
const CHROME_BG = '#1b1d21';
const CHROME_SYMBOL = '#9a9a9c';

// Per-platform frameless window options. macOS keeps its traffic lights and we place
// them ourselves; Windows/Linux draw their controls into a titleBarOverlay we colour
// to match. Anything else falls back to the native title bar rather than shipping a
// window with no way to close it.
function windowChromeOptions() {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      // Vertically centred in the 44px strip the headers reserve for it.
      trafficLightPosition: { x: 18, y: 15 },
    };
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: CHROME_BG, symbolColor: CHROME_SYMBOL, height: 40 },
    };
  }
  return {};
}

function createWindow() {
  // Restore saved window bounds
  const savedBounds = getSetting('global')?.windowBounds;
  let bounds = { width: 1400, height: 900 };

  let restorePosition = null;
  if (savedBounds && savedBounds.width && savedBounds.height) {
    bounds.width = savedBounds.width;
    bounds.height = savedBounds.height;

    // Only restore position if it's on a visible display
    if (savedBounds.x != null && savedBounds.y != null) {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return savedBounds.x >= b.x - 100 && savedBounds.x < b.x + b.width &&
               savedBounds.y >= b.y - 100 && savedBounds.y < b.y + b.height;
      });
      if (onScreen) {
        restorePosition = { x: savedBounds.x, y: savedBounds.y };
      }
    }
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'Switchboard',
    icon: path.join(__dirname, 'build', 'icon.png'),
    // Frameless chrome: the app's own sidebar/terminal headers fill the strip the
    // native title bar used to occupy. The window controls stay native and sit on
    // top of that strip — which is why the renderer insets around them per platform
    // (see the .platform-* rules in style.css) and marks header areas as drag
    // regions, or the window would have nothing left to grab.
    ...windowChromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `);
  });

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
  });

  // Save window bounds on move/resize (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // In fullscreen macOS hides the traffic lights, so the space the headers reserve
  // for them becomes a dead gap. Tell the renderer to reclaim it.
  const sendFullscreen = (isFullscreen) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fullscreen-changed', isFullscreen);
    }
  };
  mainWindow.on('enter-full-screen', () => sendFullscreen(true));
  mainWindow.on('leave-full-screen', () => sendFullscreen(false));

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }
  });

  mainWindow.on('closed', () => {
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    for (const [id, session] of [...activeSessions]) {
      markRemoteDisconnected(session);
      if (!session.exited) signalSessionTree(session, 'SIGTERM');
      activeSessions.delete(id);
    }
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Session cache helpers ---

const { deriveProjectPath } = require('./derive-project-path');

// Session cache → session-cache.js
const sessionCache = require('./session-cache');
sessionCache.init({
  PROJECTS_DIR,
  activeSessions,
  getMainWindow: () => mainWindow,
  log,
  db: {
    deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, reconcileCacheFromFilesystem,
        buildProjectsFromCache, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker } = sessionCache;

// --- IPC: browse-folder ---
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// --- IPC: add-project ---
ipcMain.handle('add-project', (_event, projectPath) => {
  try {
    // Validate the path exists and is a directory
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Unhide if previously hidden
    const global = getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      setSetting('global', global);
    }

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = require('crypto').randomUUID();
      const seedFile = path.join(folderPath, seedId + '.jsonl');
      const now = new Date().toISOString();
      const line = JSON.stringify({ type: 'user', cwd: projectPath, sessionId: seedId, uuid: require('crypto').randomUUID(), timestamp: now, message: { role: 'user', content: 'New project' } });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Immediately index the new folder so it's in cache before frontend renders
    refreshFolder(folder);
    notifyRendererProjectsChanged();

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project ---
ipcMain.handle('remove-project', (_event, projectPath) => {
  try {
    // Add to hidden projects list
    const global = getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    setSetting('global', global);

    // Clean up DB cache and search index for this folder
    const folder = encodeProjectPath(projectPath);
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    deleteSetting('project:' + projectPath);

    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remote (SSH) projects ---
// Stored in settings (global.remoteProjects) rather than derived from
// ~/.claude/projects — the session history lives on the remote host, so the
// only local state is the connection info and which tmux sessions we created.
ipcMain.handle('add-remote-project', (_event, config) => {
  const error = validateRemoteInput(config || {});
  if (error) return { error };
  const dir = normalizeRemoteDir(config.dir);
  const remote = { user: config.user, host: config.host, port: Number(config.port) || 22, ...(dir ? { dir } : {}), sessions: [] };
  const projectPath = remoteProjectPath(remote);
  const global = getSetting('global') || {};
  const list = global.remoteProjects || [];
  if (list.some(r => remoteProjectPath(r) === projectPath)) return { error: 'This remote is already added.' };
  list.push(remote);
  global.remoteProjects = list;
  setSetting('global', global);
  notifyRendererProjectsChanged();
  return { ok: true, projectPath };
});

ipcMain.handle('remove-remote-project', (_event, projectPath) => {
  const global = getSetting('global') || {};
  global.remoteProjects = (global.remoteProjects || []).filter(r => remoteProjectPath(r) !== projectPath);
  setSetting('global', global);
  // Disconnect any open connections; the remote tmux sessions live on.
  for (const [id, session] of [...activeSessions]) {
    if (session.projectPath !== projectPath) continue;
    markRemoteDisconnected(session);
    if (!session.exited) {
      stopSessionTree(id, session);
    } else {
      retireSession(id, session, 0);
    }
  }
  notifyRendererProjectsChanged();
  return { ok: true };
});

// --- IPC: get-projects ---
ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});

// --- IPC: clipboard write ---
// The renderer's navigator.clipboard.writeText is gated on focus/user-activation and
// is flaky-to-dead on Linux/Wayland (Ozone). The main-process clipboard has no such
// strings attached, so all terminal copies go through here.
ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
const fileWatchers = new Map(); // filePath → FSWatcher

ipcMain.handle('watch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  if (fileWatchers.has(resolved)) return { ok: true };
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file-changed', resolved);
        }
      }, 300);
    });
    fileWatchers.set(resolved, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('unwatch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(resolved);
  }
  return { ok: true };
});

ipcMain.handle('get-projects', (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();

    if (needsPopulate) {
      populateCacheViaWorker();
      return [];
    }

    // Pick up folders changed while the app was closed, or never indexed by an
    // older build, so sessions/worktrees don't silently go missing. Stat-gated,
    // so it's cheap when nothing has changed.
    reconcileCacheFromFilesystem();
    return buildProjectsFromCache(showArchived);
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// --- IPC: get-plans ---
ipcMain.handle('get-plans', () => {
  try {
    if (!fs.existsSync(PLANS_DIR)) return [];
    const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
    const plans = [];
    for (const file of files) {
      const filePath = path.join(PLANS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());
        const title = firstLine && firstLine.startsWith('# ')
          ? firstLine.slice(2).trim()
          : file.replace(/\.md$/, '');
        plans.push({ filename: file, title, modified: stat.mtime.toISOString() });
      } catch {}
    }
    plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // Index plans for FTS
    try {
      deleteSearchType('plan');
      upsertSearchEntries(plans.map(p => ({
        id: p.filename, type: 'plan', folder: null,
        title: p.title,
        body: fs.readFileSync(path.join(PLANS_DIR, p.filename), 'utf8'),
      })));
    } catch {}

    return plans;
  } catch (err) {
    console.error('Error reading plans:', err);
    return [];
  }
});

// --- IPC: read-plan ---
ipcMain.handle('read-plan', (_event, filename) => {
  try {
    const filePath = path.join(PLANS_DIR, path.basename(filename));
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, filePath };
  } catch (err) {
    console.error('Error reading plan:', err);
    return { content: '', filePath: '' };
  }
});

// --- IPC: save-plan ---
ipcMain.handle('save-plan', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PLANS_DIR)) {
      return { ok: false, error: 'path outside plans directory' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving plan:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: get-stats ---
ipcMain.handle('get-stats', () => {
  try {
    if (!fs.existsSync(STATS_CACHE_PATH)) return null;
    const raw = fs.readFileSync(STATS_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading stats cache:', err);
    return null;
  }
});

// --- IPC: refresh-stats (run /stats + /usage via PTY) ---
ipcMain.handle('refresh-stats', async () => {
  // For stats, use the configured shell profile
  const globalSettings = getSetting('global') || {};
  const statsProfileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
  const statsShellProfile = resolveShell(statsProfileId);
  const statsShell = statsShellProfile.path;
  const statsShellExtraArgs = statsShellProfile.args || [];
  const ptyEnv = {
    ...cleanPtyEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.6.6',
    FORCE_COLOR: '3',
    ITERM_SESSION_ID: '1',
  };

  // Helper: spawn claude with args, collect output, auto-accept trust, kill when idle
  // waitFor: optional regex tested against stripped output — finish only when matched
  function runClaude(args, { timeoutMs = 15000, waitFor = null } = {}) {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let trustAccepted = false;
      // Track idle: ✳ in OSC title means Claude is idle and waiting for input
      let sawActivity = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        try { p.kill(); } catch {}
        resolve(output);
      };

      const claudeCmd = `claude ${args}`;
      const p = pty.spawn(statsShell, shellArgs(statsShell, claudeCmd, statsShellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: ptyEnv,
      });

      const strip = (s) => s
        .replace(/\x1b\[[^@-~]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[^[\]].?/g, '');

      p.onData((data) => {
        output += data;

        // Auto-accept trust directory prompt (Enter selects "1. Yes")
        if (!trustAccepted) {
          if (/trust\s*this\s*folder/i.test(strip(output))) {
            trustAccepted = true;
            try { p.write('\r'); } catch {}
            return;
          }
        }

        // If waitFor is set, finish when that pattern appears in stripped output
        if (waitFor) {
          if (waitFor.test(strip(output))) {
            finish();
          }
          return;
        }

        // Default: detect busy→idle transition via OSC title containing ✳
        if (!sawActivity) {
          const oscTitle = data.match(/\x1b\]0;([^\x07\x1b]*)/);
          if (oscTitle) {
            const first = oscTitle[1].charAt(0);
            if (first.charCodeAt(0) >= 0x2800 && first.charCodeAt(0) <= 0x28FF) {
              sawActivity = true;
            }
          }
        } else if (data.includes('\u2733')) {
          finish();
        }
      });

      p.onExit(() => finish());
      setTimeout(finish, timeoutMs);
    });
  }

  try {
    // Run /stats via PTY (for heatmap/chart data) and fetch usage via API in parallel
    const [, usage] = await Promise.all([
      runClaude('"/stats"', { waitFor: /streak/i, timeoutMs: 10000 }),
      fetchAndTransformUsage().catch(() => ({})),
    ]);

    // Read refreshed stats cache
    let stats = null;
    try {
      if (fs.existsSync(STATS_CACHE_PATH)) {
        stats = JSON.parse(fs.readFileSync(STATS_CACHE_PATH, 'utf8'));
      }
    } catch {}

    return { stats, usage: usage || {} };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: {} };
  }
});

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  try {
    return await fetchAndTransformUsage() || {};
  } catch (err) {
    log.error('Error fetching usage:', err);
    return {};
  }
});

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-home-dev-MyClaude" → "dev/MyClaude"
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

/** Scan a directory for .md files (non-recursive). Returns array of { filename, filePath, modified }. */
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        const content = fs.readFileSync(fp, 'utf8').trim();
        if (content) {
          const stat = fs.statSync(fp);
          results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString() });
        }
      }
    }
  } catch {}
  return results;
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // --- Global files ---
  const globalFiles = scanMdFiles(CLAUDE_DIR).map(f => ({ ...f, displayPath: '~/.claude' }));

  // --- Per-project files ---
  const projects = [];
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (projectPath && hiddenProjects.has(projectPath)) continue;

        // Use same 2-deep short path as Sessions tab (e.g. "dev/MyClaude")
        // Splits on both separators — `cwd` is backslash-separated on Windows,
        // where splitting on '/' alone left the whole path as one segment.
        const shortName = projectPath
          ? projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [];
        const seenPaths = new Set();

        // 1. ~/.claude/projects/{folder}/ — claude-home .md files
        const claudeHomeFiles = scanMdFiles(folderPath);
        for (const f of claudeHomeFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }
        // memory/MEMORY.md
        const memoryDir = path.join(folderPath, 'memory');
        const memoryFiles = scanMdFiles(memoryDir);
        for (const f of memoryFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }

        // 2. {projectPath}/ — project root CLAUDE.md, agents.md
        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = path.join(projectPath, name);
            try {
              if (fs.existsSync(fp)) {
                const content = fs.readFileSync(fp, 'utf8').trim();
                if (content && !seenPaths.has(fp)) {
                  const stat = fs.statSync(fp);
                  files.push({ filename: name, filePath: fp, modified: stat.mtime.toISOString(), displayPath: shortName + '/', source: 'project' });
                  seenPaths.add(fp);
                }
              }
            } catch {}
          }

          // 3. {projectPath}/.claude/ — commands/*.md and other .md files
          const dotClaudeDir = path.join(projectPath, '.claude');
          const dotClaudeFiles = scanMdFiles(dotClaudeDir);
          for (const f of dotClaudeFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
          // commands/*.md
          const commandsDir = path.join(dotClaudeDir, 'commands');
          const commandFiles = scanMdFiles(commandsDir);
          for (const f of commandFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/commands/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
        }

        if (files.length > 0) {
          projects.push({ folder, projectPath: projectPath || '', shortName, files });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  // Sort projects by most recent file modified date
  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  // Index all files for FTS
  try {
    deleteSearchType('memory');
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.shortName }))),
    ];
    upsertSearchEntries(allFiles.map(f => ({
      id: f.filePath, type: 'memory', folder: null,
      title: f.label + ' ' + f.filename,
      body: fs.readFileSync(f.filePath, 'utf8'),
    })));
  } catch {}

  return result;
});

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    // Allow paths under ~/.claude/ or any .md file that exists
    if (!resolved.endsWith('.md')) return '';
    if (!resolved.startsWith(CLAUDE_DIR) && !fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: search ---
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchByType(type, query, 50, !!titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  setSetting(key, value);
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
});

// --- Scheduled tasks ---
const scheduleIpc = require('./schedule-ipc');

const SETTING_DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  worktree: false,
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  terminalFontFamily: '',
  terminalFontSize: 12,
  terminalLineHeight: 1,
  mcpEmulation: false,
  shellProfile: 'auto',
};

ipcMain.handle('get-shell-profiles', () => {
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

ipcMain.handle('get-effective-settings', (_event, projectPath) => {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) {
      effective[key] = global[key];
    }
    if (project[key] !== undefined && project[key] !== null) {
      effective[key] = project[key];
    }
  }
  return effective;
});

// --- IPC: get-active-sessions ---
ipcMain.handle('get-active-sessions', () => {
  const active = [];
  // Snapshot, because a session retired below deletes itself from the map.
  for (const [sessionId, session] of [...activeSessions]) {
    // A remote session between connections is still live — the tmux session is
    // running and a reconnect is on a timer — so it counts as active. Reporting
    // it stopped would blank its sidebar dot for a second and stop the renderer
    // restoring it after a reload.
    if (isRemoteReconnecting(session)) { active.push(sessionId); continue; }
    if (session.exited) continue;
    // `exited` is only ever set from the PTY's exit event, so a process that
    // died without one would keep this row green for the life of the app. The
    // pid is the ground truth, and checking it lets a stuck row heal itself on
    // the next poll instead of needing a restart.
    if (!isPtyAlive(session)) {
      log.warn(`[active] session=${sessionId} pid=${session.pty && session.pty.pid} gone with no exit event — retiring`);
      retireSession(sessionId, session, -1);
      continue;
    }
    active.push(sessionId);
  }
  return active;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal) {
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
// `ok` means nothing is running under that id any more — either it never was,
// or it has been retired, or a kill is on its way that will retire it. Callers
// that hide a row (archive) can rely on that; `ok: false` means the record is
// still live and the row should stay.
ipcMain.handle('stop-session', (_event, sessionId) => {
  const found = findActiveSession(sessionId);
  if (!found) return { ok: true, alreadyStopped: true };
  const { key, session } = found;

  // Remote sessions: stop reconnecting first, or killing the PTY (or the retry
  // already on a timer) would just dial straight back out.
  if (session.remote) {
    const wasWaiting = session.exited;
    markRemoteDisconnected(session);
    if (wasWaiting) {
      // Nothing to kill — the connection is already down and only the backoff
      // was keeping the session alive. Retire it the way an exit would.
      sendRemoteStatus(key, { phase: 'disconnected', target: session.remote.target });
      retireSession(key, session, 0);
      return { ok: true, alreadyStopped: true };
    }
  }

  // Dead process, live record: the exit event never landed. Nothing to signal,
  // but the record still has to go or the row stays on "Running".
  if (session.exited || !isPtyAlive(session)) {
    retireSession(key, session, 0);
    return { ok: true, alreadyStopped: true };
  }

  stopSessionTree(key, session);
  return { ok: true };
});

// --- IPC: reconnect-remote ---
// "Retry now" on the connecting card: skip the rest of the backoff. Safe to
// call at any time — it no-ops unless the session is remote, still held, and
// actually between connections.
ipcMain.handle('reconnect-remote', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || !session.remote) return { ok: false, error: 'not a remote session' };
  if (session.remote.userDisconnected) return { ok: false, error: 'disconnected' };
  if (!session.exited) return { ok: true, alreadyConnected: true };
  // An explicit ask starts the backoff ladder over: the user knows something
  // changed (VPN up, host awake) that the previous attempts did not.
  session.remote.attempt = 0;
  reconnectRemoteNow(sessionId);
  return { ok: true };
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const starred = toggleStar(sessionId);
  return { starred };
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', (_event, sessionId, name) => {
  setName(sessionId, name || null);
  // Update search index title to include the new name
  const cached = getCachedSession(sessionId);
  const summary = cached?.summary || '';
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + summary);
  return { name: name || null };
});

// --- IPC: archive-session ---
ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  const jsonlPath = path.join(PROJECTS_DIR, folder, sessionId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
});

// --- PTY wiring ---
// Data/exit handlers for a spawned PTY. Kept out of the open-terminal handler
// because a remote session re-spawns its PTY on every reconnect and has to
// rewire the fresh one to the same session record.
function wirePty(session, sessionId, ptyProcess) {
  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    if (session.remote) noteRemoteOutput(sessionId, session, data);

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle)
        if (code === '0') {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733'; // ✳
          log.debug(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 0] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            log.debug(`[OSC 0] session=${currentId} → IDLE`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          if (level === '0') continue; // 4;0 is also used for clearing, making it unreliable as an idle signal
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy}`);
          if ((level === '1' || level === '2' || level === '3') && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          }
        } else {
          // Regular notification (attention, permission, etc.)
          log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal-notification', currentId, payload);
          }
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
        session.outputBufferSize -= session.outputBuffer.shift().length;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;

    // A remote session's PTY is one SSH connection, not the session itself —
    // the work lives in tmux on the far end. If the link can come back, keep
    // the session (and the renderer's terminal) alive and dial again.
    if (session.remote && handleRemoteExit(sessionId, session, exitCode, signal)) return;

    retireSession(sessionId, session, exitCode);
  });
}

// --- Remote (SSH) session connection lifecycle ---
// A remote session outlives its SSH connection: the tmux session on the host
// keeps running, so a dropped link is a transport problem to retry rather than
// the end of the session. Everything below keeps one `session.remote` record in
// step with that — which connection attempt we are on, whether the user asked
// to disconnect, and what to tell the renderer so the UI isn't a black
// rectangle while ssh works (or hangs).

// How long a connection has to survive before it counts as "real". Without
// this, an ssh that connects far enough to print a rejection and then dies
// would reset the backoff on every cycle and reconnect forever at 1s.
const REMOTE_STABLE_MS = 20000;

function sendRemoteStatus(sessionId, status) {
  const session = activeSessions.get(sessionId);
  // Remembered so a renderer that reloads (or reattaches) can be told where
  // the connection stands instead of inferring it from an empty screen.
  if (session && session.remote) session.remote.status = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-status', sessionId, status);
  }
}

function spawnRemotePty(sessionId, session) {
  const r = session.remote;
  const sshArgv = buildSshArgv(r.remote, sessionId, r.kind);
  // ssh runs via the user's login shell (see buildSshSpawn) because the
  // environment this app inherits from the desktop session points at the
  // wrong ssh-agent; ssh reads ~/.ssh/config itself (IdentityAgent etc.).
  const sshSpawn = buildSshSpawn(sshArgv, { shell: r.shell, shellExtraArgs: r.shellExtraArgs });
  log.info(`[remote] session=${sessionId} attempt=${r.attempt} ssh ${sshArgv.slice(0, -1).join(' ')} <tmux attach> via ${sshSpawn.file}`);
  return pty.spawn(sshSpawn.file, sshSpawn.args, {
    name: 'xterm-256color',
    // Reconnect at the size the renderer's terminal actually is, so tmux
    // repaints correctly instead of at the 120x30 spawn default and then
    // reflowing once the first resize arrives.
    cols: r.cols || 120,
    rows: r.rows || 30,
    cwd: os.homedir(),
    env: { ...cleanPtyEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
}

// Output from the far end is what ends the "connecting" state — an auth prompt,
// a login banner, tmux repainting. ssh's own transport errors are excluded:
// they arrive on the same PTY but mean the opposite, and counting them as a
// connect made the card vanish and come back (see outputProvesRemoteIsLive).
//
// Output is also where a permanently-broken connection announces itself, and
// the phrase can straddle two chunks, so a short tail is kept.
function noteRemoteOutput(sessionId, session, data) {
  const r = session.remote;
  if (!r.fatal) {
    const recent = (r.tail || '') + data;
    if (isFatalSshOutput(recent)) r.fatal = true;
    r.tail = recent.slice(-256);
  }
  if (!r.sawData && outputProvesRemoteIsLive(data)) {
    r.sawData = true;
    r.everConnected = true;
    sendRemoteStatus(sessionId, { phase: 'connected', target: r.target });
  }
}

// Returns true when the session lives on (a reconnect is scheduled) and false
// when the caller should run the normal exit teardown.
function handleRemoteExit(sessionId, session, exitCode, signal) {
  const r = session.remote;
  const lasted = Date.now() - (r.spawnedAt || 0);
  // signal and sawData are both logged because they are what distinguishes the
  // failure modes after the fact: a killed ssh from a clean exit, and a host
  // that never spoke from one that did.
  log.info(`[remote] session=${sessionId} ssh exited code=${exitCode} signal=${signal || 'none'} after=${Math.round(lasted / 1000)}s attempt=${r.attempt} sawData=${!!r.sawData} fatal=${!!r.fatal} byUser=${!!r.userDisconnected}`);

  if (r.userDisconnected) {
    sendRemoteStatus(sessionId, { phase: 'disconnected', target: r.target });
    return false;
  }
  if (r.fatal) {
    sendRemoteStatus(sessionId, { phase: 'failed', target: r.target, reason: 'the host rejected the connection' });
    return false;
  }
  // Exit 0 (left the shell, detached tmux) and the tmux-missing bail-out are
  // answers, not transport failures — reconnecting would fight the user.
  if (!isRetryableSshExit(exitCode, signal)) {
    sendRemoteStatus(sessionId, { phase: 'disconnected', target: r.target, reason: describeSshExit(exitCode, signal) });
    return false;
  }
  // A link that stood up for a while was genuinely working, so the next break
  // starts the backoff over rather than inheriting the previous attempt count.
  if (lasted >= REMOTE_STABLE_MS) r.attempt = 0;
  return scheduleRemoteReconnect(sessionId, session, describeSshExit(exitCode, signal));
}

function scheduleRemoteReconnect(sessionId, session, reason) {
  const r = session.remote;
  r.attempt += 1;
  if (r.attempt > REMOTE_MAX_RETRIES) {
    log.warn(`[remote] session=${sessionId} giving up after ${REMOTE_MAX_RETRIES} attempts`);
    sendRemoteStatus(sessionId, {
      phase: 'failed', target: r.target, reason,
      attempts: REMOTE_MAX_RETRIES, everConnected: !!r.everConnected,
    });
    return false;
  }
  const delayMs = remoteRetryDelay(r.attempt);
  sendRemoteStatus(sessionId, {
    phase: 'retrying', target: r.target, reason,
    attempt: r.attempt, maxAttempts: REMOTE_MAX_RETRIES, delayMs,
    everConnected: !!r.everConnected,
  });
  clearTimeout(r.timer);
  r.timer = setTimeout(() => { r.timer = null; reconnectRemoteNow(sessionId); }, delayMs);
  return true;
}

// Dial again now, cancelling any pending backoff. Also the "the user clicked
// the session, they want it back" path, which shouldn't wait out the timer.
function reconnectRemoteNow(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || !session.remote) return;
  const r = session.remote;
  clearTimeout(r.timer);
  r.timer = null;
  if (r.userDisconnected || !session.exited) return;

  let ptyProcess;
  try {
    ptyProcess = spawnRemotePty(sessionId, session);
  } catch (err) {
    log.error(`[remote] session=${sessionId} respawn failed: ${err.message}`);
    scheduleRemoteReconnect(sessionId, session, err.message);
    return;
  }
  session.pty = ptyProcess;
  session.exited = false;
  session.firstResize = true;
  r.spawnedAt = Date.now();
  r.sawData = false;
  r.tail = '';
  sendRemoteStatus(sessionId, {
    phase: 'connecting', target: r.target,
    attempt: r.attempt, maxAttempts: REMOTE_MAX_RETRIES,
  });
  wirePty(session, sessionId, ptyProcess);
}

function isRemoteReconnecting(session) {
  return !!(session && session.remote && session.remote.timer && !session.remote.userDisconnected);
}

// The user asked to stop, so stop trying. Marked on the record rather than
// just clearing the timer, because the PTY's own exit runs afterwards and
// would otherwise read as a drop worth retrying.
function markRemoteDisconnected(session) {
  if (!session || !session.remote) return;
  session.remote.userDisconnected = true;
  clearTimeout(session.remote.timer);
  session.remote.timer = null;
}

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // A remote session waiting out its reconnect backoff is still "here": its
    // buffer replays below like any other reattach. Clicking it is an explicit
    // ask for the connection back, so it skips the rest of the wait — done
    // after the replay so the new status line lands on top of the old screen.
    const remoteRedial = session.remote && session.exited && !session.remote.userDisconnected;
    // Otherwise re-send where the connection stands, so a renderer that just
    // reloaded doesn't have to infer it from a blank terminal.
    if (session.remote && !remoteRedial && session.remote.status) {
      sendRemoteStatus(sessionId, session.remote.status);
    }

    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      mainWindow.webContents.send('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    if (remoteRedial) reconnectRemoteNow(sessionId);

    return { ok: true, reattached: true, mcpActive: !!session.mcpServer };
  }

  // Spawn new PTY
  const isRemote = isRemoteProjectPath(projectPath);
  if (!isRemote && !fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  const isPlainTerminal = !isRemote && sessionOptions?.type === 'terminal';

  // Resolve shell profile from effective settings
  const effectiveProfileId = (() => {
    const global = getSetting('global') || {};
    const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
    let profileId = SETTING_DEFAULTS.shellProfile;
    if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
    if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
    return profileId;
  })();
  // WSL profiles only work for plain terminals — Claude CLI sessions need the
  // Windows shell because session data lives on the Windows filesystem.
  const requestedProfile = resolveShell(effectiveProfileId);
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(projectPath);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal && !isRemote) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }

    // Read slug from the session's jsonl file (for plan-accept detection)
    if (!isNew) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = fs.readFileSync(jsonlPath, 'utf8').slice(0, 8000);
        const firstLines = head.split('\n').filter(Boolean);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  let ptyProcess;
  let mcpServer = null;
  let remoteState = null;
  try {
    if (isRemote) {
      // Remote (SSH) project: the "session" is a tmux session on the remote
      // host and the PTY runs ssh attached to it. No local jsonl files, no MCP
      // server, no shell profile — and no auto-connect: this code only runs
      // when the user clicks, because auth may need interaction (host key
      // prompts, 1Password approval, passwords) that renders in the terminal.
      const remote = parseRemoteProjectPath(projectPath);
      if (!remote) return { ok: false, error: `invalid remote project: ${projectPath}` };

      // Record the session in settings (or bump lastOpened) so it reappears in
      // the sidebar after a restart without connecting on its own.
      const global = getSetting('global') || {};
      const remoteProject = (global.remoteProjects || []).find(r => remoteProjectPath(r) === projectPath);
      if (!remoteProject) return { ok: false, error: `remote project no longer exists: ${projectPath}` };
      remoteProject.sessions = remoteProject.sessions || [];
      let record = remoteProject.sessions.find(s => s.sessionId === sessionId);
      if (!record) {
        record = {
          sessionId,
          kind: sessionOptions?.remoteKind === 'shell' ? 'shell' : 'claude',
          created: new Date().toISOString(),
        };
        remoteProject.sessions.push(record);
      }
      record.lastOpened = new Date().toISOString();
      setSetting('global', global);
      notifyRendererProjectsChanged();

      // Everything a reconnect needs, so re-dialling never has to go back to
      // settings or re-resolve the shell profile (see reconnectRemoteNow).
      remoteState = {
        remote, kind: record.kind, shell, shellExtraArgs,
        target: remote.user + '@' + remote.host + (normalizeRemoteDir(remote.dir) ? ':' + normalizeRemoteDir(remote.dir) : ''),
        attempt: 0, timer: null, sawData: false, tail: '',
        userDisconnected: false, fatal: false, everConnected: false,
        spawnedAt: Date.now(),
      };
      ptyProcess = spawnRemotePty(sessionId, { remote: remoteState });
    } else if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Inject a shell function to override `claude` with a helpful message
      const claudeShim = 'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
      ptyProcess = pty.spawn(shell, shellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          CLAUDECODE: '1',
          // ZDOTDIR trick won't work reliably; instead inject via ENV (sh/bash) or precmd
          ENV: claudeShim,
          BASH_ENV: claudeShim,
        },
      });
      // For zsh, ENV/BASH_ENV don't apply — write the function after shell starts
      setTimeout(() => {
        if (!ptyProcess._isDisposed) {
          try {
            ptyProcess.write(claudeShim + ' clear\n');
          } catch {}
        }
      }, 300);
    } else {
      // Build claude command, using array to prevent accidental shell injection
      const claudeArgs = [];
      if (sessionOptions?.forkFrom) {
        claudeArgs.push('--resume', String(sessionOptions.forkFrom), '--fork-session');
      } else if (isNew) {
        claudeArgs.push('--session-id', String(sessionId));
      } else {
        claudeArgs.push('--resume', String(sessionId));
      }

      if (sessionOptions) {
        if (sessionOptions.dangerouslySkipPermissions) {
          claudeArgs.push('--dangerously-skip-permissions');
        } else if (sessionOptions.permissionMode) {
          claudeArgs.push('--permission-mode', String(sessionOptions.permissionMode));
        }
        // --worktree only applies when STARTING a session — it creates a fresh
        // isolated git worktree. Resuming (isNew === false) must reuse the
        // session's existing directory, so ignore the worktree option on resume
        // regardless of which call site supplied it (sidebar click, schedule
        // creator, fork, …). Otherwise a resume tries to spin up a new worktree
        // and fails to attach.
        if (isNew && sessionOptions.worktree) {
          claudeArgs.push('--worktree');
          if (sessionOptions.worktreeName) {
            claudeArgs.push(String(sessionOptions.worktreeName));
          }
        }
        if (sessionOptions.chrome) {
          claudeArgs.push('--chrome');
        }
        if (sessionOptions.addDirs) {
          const dirs = String(sessionOptions.addDirs).split(',').map(d => d.trim()).filter(Boolean);
          for (const dir of dirs) {
            claudeArgs.push('--add-dir', dir);
          }
        }
      }

      if (sessionOptions?.appendSystemPrompt) {
        claudeArgs.push('--append-system-prompt', String(sessionOptions.appendSystemPrompt));
      }

      let claudeCmd = 'claude ' + quoteArgvForShell(shell, claudeArgs);

      // preLaunchCmd is raw shell by design (e.g. "aws-vault exec profile --") — block newlines only
      if (sessionOptions?.preLaunchCmd) {
        const pre = String(sessionOptions.preLaunchCmd);
        if (/[\r\n]/.test(pre)) {
          return { ok: false, error: 'preLaunchCmd must not contain newlines' };
        }
        claudeCmd = pre + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await startMcpServer(sessionId, [projectPath], mainWindow, log);
          claudeCmd += ' --ide';
        } catch (err) {
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      if (mcpServer) {
        ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);
      }

      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    isPlainTerminal, forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
    remote: remoteState,
  };
  activeSessions.set(sessionId, session);

  wirePty(session, sessionId, ptyProcess);

  // Tell the renderer a connection is in flight. Until ssh prints something
  // there is nothing on screen at all, and a slow or unreachable host is
  // otherwise indistinguishable from the app doing nothing.
  if (remoteState) {
    sendRemoteStatus(sessionId, { phase: 'connecting', target: remoteState.target });
  }

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    session.pty.write(data);
  }
});

// --- IPC: terminal-resize (fire-and-forget) ---
ipcMain.on('terminal-resize', (_event, sessionId, cols, rows) => {
  const session = activeSessions.get(sessionId);
  // Remembered even while the connection is down: the next ssh spawns at this
  // size so tmux repaints to fit instead of reflowing after the fact.
  if (session && session.remote) { session.remote.cols = cols; session.remote.rows = rows; }
  if (session && !session.exited) {
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      setTimeout(() => {
        try {
          session.pty.resize(cols + 1, rows);
          setTimeout(() => {
            try { session.pty.resize(cols, rows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    }
  }
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
});

// Session transitions → session-transitions.js
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({ PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer });
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;

  const pendingFolders = new Set();
  let debounceTimer = null;

  function flushChanges() {
    debounceTimer = null;
    const folders = new Set(pendingFolders);
    pendingFolders.clear();

    let changed = false;
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        refreshFolder(folder);
      } else {
        deleteCachedFolder(folder);
      }
      changed = true;
    }

    if (changed) {
      notifyRendererProjectsChanged();
    }
  }

  try {
    projectsWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        pendingFolders.add(folder);
      } else if (basename.endsWith('.jsonl')) {
        pendingFolders.add(folder);
      } else {
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, 500);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// --- IPC: auto-updater ---
ipcMain.handle('updater-check', () => {
  if (!autoUpdater) return { available: false, dev: true };
  return autoUpdater.checkForUpdates();
});
ipcMain.handle('updater-download', () => {
  if (!autoUpdater) return;
  return autoUpdater.downloadUpdate();
});
ipcMain.handle('updater-install', () => {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall();
});

// --- App lifecycle ---
// Prevent a second Electron instance from killing active PTY sessions.
// This happens when the user replaces the AppImage while Switchboard is running:
// the OS spawns the new binary, which would otherwise initialise a second process
// and leave the first one's node-pty sessions orphaned or killed.
// requestSingleInstanceLock ensures only one instance runs at a time. The second
// launch quits immediately; the first brings its window to the front.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Focus the existing window when a second launch is attempted.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    startProjectsWatcher();
    scheduleIpc.ensureScheduleCreatorCommand();

    // Shared runCommand for cron scheduler and "run now" — takes argv, not a shell string
    const { spawn: cpSpawn } = require('child_process');
    function runScheduleCommand(claudeArgv, cwd, name, onDone) {
      const globalSettings = getSetting('global') || {};
      const profileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
      const profile = resolveShell(profileId);
      const shell = profile.path;
      const cmd = 'claude ' + quoteArgvForShell(shell, claudeArgv);
      const args = shellArgs(shell, cmd, profile.args || []);

      log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
      const child = cpSpawn(shell, args, {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...cleanPtyEnv, FORCE_COLOR: '0' },
      });

      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('exit', (code) => {
        if (stderr.trim()) log.error(`[schedule] ${name} stderr:\n${stderr.trim()}`);
        log.info(`[schedule] ${name} finished (exit ${code})`);
        if (onDone) onDone();
      });

      child.on('error', (err) => {
        log.error(`[schedule] ${name} error:`, err.message);
        if (onDone) onDone();
      });
    }

    scheduleIpc.init(log, runScheduleCommand);
    startScheduler(log, runScheduleCommand);

    // Re-index search if FTS table was recreated (e.g. tokenizer config change)
    if (searchFtsRecreated) populateCacheViaWorker();

    // Check for updates after launch
    if (autoUpdater) {
      setTimeout(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 5000);
      // Re-check every 4 hours for long-running sessions
      setInterval(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 4 * 60 * 60 * 1000);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }); // end app.whenReady
} // end gotSingleInstanceLock else-branch

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Shut down all MCP servers
  shutdownAllMcp();

  // Close filesystem watcher
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }

  // Kill all PTY processes on quit
  for (const [, session] of activeSessions) {
    markRemoteDisconnected(session);
    // SIGTERM to the group rather than SIGHUP to the shell: the shell is only a
    // wrapper, and the `claude` underneath it would otherwise be orphaned.
    if (!session.exited) signalSessionTree(session, 'SIGTERM');
  }
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  closeDb();
});
