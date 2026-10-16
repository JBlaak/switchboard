/**
 * Reaching into the main process from a test, without a seam in the app.
 *
 * Playwright's `ElectronApplication.evaluate` runs a function in the main
 * process with the `electron` module as its argument. That is enough for two
 * things the harness needs:
 *
 * - **Host stubs.** A few IPC channels answer with facts about the machine the
 *   suite happens to run on (is sleep disabled right now?) or act on it (open a
 *   browser, show a folder picker, write the clipboard, prompt for an
 *   administrator password). Their handlers are swapped for test doubles, so
 *   a run is the same on every Mac and a stray click cannot reach the host.
 * - **Pushing events.** Anything main tells the renderer travels as a
 *   `webContents.send` on a channel from src/ipc/channels.ts, so a test can
 *   send one directly — a remote status, say — to put the UI in a state that
 *   would otherwise take a real network failure to reach.
 *
 * The channel names come from the app's own table, so a renamed channel breaks
 * the harness at compile time rather than leaving a stub silently unused.
 */
import type { ElectronApplication } from '@playwright/test';
import { EVENT, INVOKE } from '../../src/ipc/channels';
import type { RemoteStatusPayload } from '../../src/domain/remote/remote-status';
import type { Usage } from '../../src/domain/usage/usage';

/**
 * The usage the gauges show unless a test says otherwise: fixed numbers, with
 * reset labels already formatted, so the footer looks the same on every run
 * without any credentials or network.
 */
export const STUB_USAGE: Usage = {
  limits: [
    { kind: 'session', label: 'Current session', model: null, percent: 42, reset: '6pm (UTC)', severity: 'normal' },
    { kind: 'weekly_all', label: 'Week (all models)', model: null, percent: 67, reset: 'Jun 12 at 9am (UTC)', severity: 'normal' },
  ],
};

export interface HostStubs {
  /** What `getUsage` answers; null hides the gauges. */
  usage: Usage | null;
  /** Whether `pmset` would report sleep as disabled. */
  sleepDisabled: boolean;
  /** What the folder picker "chooses"; null is a cancelled dialog. */
  browseFolder: string | null;
}

/**
 * What the stubs keep in the main process, on `globalThis.__switchboardE2E`.
 * Evaluated functions are serialised into main, so they reach it through this
 * global rather than through a closure.
 */
interface StubState extends HostStubs {
  opened: string[];
  clipboard: string[];
}

type WithStubs = typeof globalThis & { __switchboardE2E: StubState };

export const DEFAULT_STUBS: HostStubs = {
  usage: STUB_USAGE,
  sleepDisabled: false,
  browseFolder: null,
};

/** Replace the host-facing IPC handlers. Call before the renderer (re)loads. */
export async function installHostStubs(app: ElectronApplication, stubs: HostStubs): Promise<void> {
  await app.evaluate(({ ipcMain }, { stubs, channels }) => {
    const state: StubState = { ...stubs, opened: [], clipboard: [] };
    (globalThis as WithStubs).__switchboardE2E = state;

    const replace = (channel: string, handler: (...args: unknown[]) => unknown): void => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...args) => handler(...args));
    };

    replace(channels.getUsage, () => state.usage);
    replace(channels.getSleepDisabled, () => state.sleepDisabled);
    replace(channels.setSleepDisabled, (disabled) => {
      state.sleepDisabled = !!disabled;
      return state.sleepDisabled;
    });
    replace(channels.browseFolder, () => state.browseFolder);
    replace(channels.openExternal, (url) => {
      state.opened.push(String(url));
    });
    // The real clipboard is the user's: a test that copies must not overwrite it.
    replace(channels.writeClipboard, (text) => {
      state.clipboard.push(String(text));
    });
    replace(channels.openRepository, (projectPath) => {
      state.opened.push('repository:' + String(projectPath));
      return true;
    });
  }, { stubs, channels: INVOKE });
}

/** Change a stub mid-test (takes effect on the renderer's next request). */
export async function setHostStub<K extends keyof HostStubs>(
  app: ElectronApplication, key: K, value: HostStubs[K],
): Promise<void> {
  await app.evaluate((_electron, { key, value }) => {
    ((globalThis as WithStubs).__switchboardE2E as unknown as Record<string, unknown>)[key] = value;
  }, { key, value });
}

/**
 * The URLs the app tried to open in a browser — PR chips, terminal links — and
 * `repository:<path>` for each "open repository" request.
 */
export async function openedExternally(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(() => {
    return [...(globalThis as WithStubs).__switchboardE2E.opened];
  });
}

/** Everything the app wrote to the clipboard (stubbed; the host's is never touched). */
export async function clipboardWrites(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(() => {
    return [...(globalThis as WithStubs).__switchboardE2E.clipboard];
  });
}

/** Send the renderer an event, as main would. */
export async function pushEvent(app: ElectronApplication, channel: string, ...args: unknown[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { channel, args }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, ...args);
  }, { channel, args });
}

/**
 * Tell the renderer a remote session's connection is in some phase.
 *
 * The connection card lives in the session's terminal container, so the
 * session has to be open (clicked) first; opening it is also what starts the
 * fake `ssh`. Real transitions can be driven through `fakeSsh` instead — this
 * is for the phases that would need a real network to reach, or a precise
 * backoff delay.
 */
export async function pushRemoteStatus(
  app: ElectronApplication, sessionId: string, status: RemoteStatusPayload,
): Promise<void> {
  await pushEvent(app, EVENT.remoteStatus, sessionId, status);
}
