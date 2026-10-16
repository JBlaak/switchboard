/**
 * Starting the built app against a fixture home, the same way on every run.
 *
 * What "the same way" takes:
 *
 * - **Isolation.** HOME, SWITCHBOARD_DATA_DIR and CLAUDE_CONFIG_DIR all point
 *   into the fixture. The data dir also gives the instance its own Electron
 *   userData and so its own single-instance lock, which is what lets it run
 *   beside an installed Switchboard and beside the other workers.
 * - **No network.** Weather is switched off in the fixture's settings, and
 *   usage is stubbed. Even unstubbed it would find no credentials: with
 *   CLAUDE_CONFIG_DIR set, the Keychain item the app looks for is the hashed
 *   one the CLI would create for that directory, which does not exist, and
 *   the fixture holds no credentials file.
 * - **Pixels.** One device pixel per CSS pixel, a fixed content size, reduced
 *   motion, and a renderer clock frozen at FIXTURE_NOW (timers still run).
 *   TZ=UTC makes that frozen instant the same wall-clock time everywhere.
 * - **The host.** The IPC handlers that read or act on the machine itself
 *   (sleep, usage, the browser, the folder picker) are swapped for stubs; see
 *   main-process.ts.
 * - **The shell.** SHELL is pinned to zsh so the profile that puts the fakes
 *   on PATH is the one that runs, whatever the host's login shell is.
 */
import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { FIXTURE_NOW } from './fixture-home';
import { DEFAULT_STUBS, installHostStubs } from './main-process';
import type { FixtureHome } from './fixture-home';
import type { HostStubs } from './main-process';

const REPO_ROOT = path.join(__dirname, '..', '..');

/** The renderer's viewport. Matches HARNESS_SETTINGS.windowBounds. */
export const WINDOW_SIZE = { width: 1280, height: 800 } as const;

/** Variables from the runner's environment that must not reach the app. */
const STRIPPED_ENV = [
  // Electron-as-Node would start Node instead of the app.
  'ELECTRON_RUN_AS_NODE',
  // zsh reads its startup files from ZDOTDIR when set, bypassing the fixture's.
  'ZDOTDIR',
  // The suite's own shell might be bash or fish; the fakes' PATH is set up for zsh.
  'BASH_ENV', 'ENV',
];

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Fake timers on the renderer's clock instead of only a frozen `Date`. */
  fakeTimers?: boolean;
}

export async function launchApp(
  home: FixtureHome,
  stubs: Partial<HostStubs> = {},
  { fakeTimers = false }: LaunchOptions = {},
): Promise<LaunchedApp> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED_ENV.includes(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: home.home,
    SWITCHBOARD_DATA_DIR: home.dataDir,
    CLAUDE_CONFIG_DIR: path.join(home.home, '.claude'),
    SHELL: '/bin/zsh',
    // Lets the window keep its fixed size on a display smaller than it.
    SWITCHBOARD_E2E: '1',
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  });

  const app = await electron.launch({
    args: [
      '--force-device-scale-factor=1',
      '--force-prefers-reduced-motion',
      path.join(REPO_ROOT, 'app', 'main.js'),
    ],
    cwd: REPO_ROOT,
    env,
  });

  let page: Page;
  try {
    page = await app.firstWindow();
    await installHostStubs(app, { ...DEFAULT_STUBS, ...stubs });
    await settleWindow(app, page, fakeTimers);
  } catch (err) {
    await quit(app);
    throw err;
  }

  return {
    app,
    page,
    close: async () => {
      // Quitting (not closing the window, which on macOS leaves the app in the
      // Dock) runs the app's before-quit, which signals every session's
      // process group — so the fake CLIs go with it.
      await quit(app);
    },
  };
}

/** How long a quit may take before the app is killed instead. */
const QUIT_TIMEOUT_MS = 10_000;

/**
 * Quit the app, and kill it if it will not go.
 *
 * On a loaded CI Mac a quit now and then never finishes, and Playwright then
 * waits out its whole worker teardown and fails the run with no test to blame.
 * Killing the main process closes the PTYs' masters, which hangs up the
 * sessions still under them.
 */
async function quit(app: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), QUIT_TIMEOUT_MS);
  });
  const outcome = await Promise.race([app.close().catch(() => 'closed' as const), timedOut]);
  clearTimeout(timer);
  // The process can be gone already by the time the timeout fires.
  if (outcome === 'timeout') {
    try { app.process()?.kill('SIGKILL'); } catch { /* already exited */ }
  }
}

/**
 * Bring the window into its deterministic state.
 *
 * The clock has to be in place before the renderer's first script runs —
 * relative times are painted on the first render — and the first window is
 * already loading by the time Playwright hands it over. So the clock is
 * installed on the context and the page reloaded once, which also makes the
 * reduced-motion emulation and the host stubs apply from the first frame. The
 * reload is safe: nothing has been launched yet, and the renderer rebuilds
 * itself from main.
 *
 * With `fakeTimers` the clock is installed instead of fixed: it starts at
 * FIXTURE_NOW and runs on from there, and `page.clock.fastForward` can jump
 * the renderer's timers ahead. Only for tests about timing, since the running
 * clock lets relative times drift away from the screenshots'.
 */
async function settleWindow(app: ElectronApplication, page: Page, fakeTimers: boolean): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(size.width, size.height);
    window.center();
  }, WINDOW_SIZE);

  if (fakeTimers) await page.context().clock.install({ time: FIXTURE_NOW });
  else await page.context().clock.setFixedTime(FIXTURE_NOW);
  // colorScheme: null, explicitly. Playwright otherwise emulates `light` along
  // with whatever is asked for, which would hide the app's own dark mode: the
  // scheme has to come from the appearance setting, through nativeTheme, as it
  // does for a user.
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: null });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
}
