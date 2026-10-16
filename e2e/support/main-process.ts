/**
 * Reaching into the main process from a test, without a seam in the app.
 *
 * Playwright's `ElectronApplication.evaluate` runs a function in the main
 * process with the `electron` module as its argument. That is enough for two
 * things the harness needs:
 *
 * - **Host stubs.** A few IPC channels answer with facts about the machine the
 *   suite happens to run on (is sleep disabled right now? is there a newer
 *   release?) or act on it (open a browser, show a folder picker, replace the
 *   app, prompt for an administrator password). Their
 *   handlers are swapped for test doubles, so a run is the same on every Mac
 *   and a stray click cannot reach the host.
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
import type { UpdateNotice } from '../../src/domain/update/release';
import type { Usage } from '../../src/domain/usage/usage';
import type { WeatherLocation } from '../../src/domain/weather/weather';

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
  /** Make `getUsage` fail, as it does offline or without credentials. */
  usageFails: boolean;
  /** What `getUpdate` answers: the release main has found, or null for none. */
  update: UpdateNotice | null;
  /**
   * What `installUpdate` answers. 'pending' never answers, which is what the
   * renderer sees when an install works: the app quits from under it.
   */
  installUpdate: boolean | 'pending';
  /** Whether `pmset` would report sleep as disabled. */
  sleepDisabled: boolean;
  /** What the folder picker "chooses"; null is a cancelled dialog. */
  browseFolder: string | null;
  /**
   * What looking up a weather city answers, by the name typed: a location
   * (after `delayMs`, to hold a lookup in flight), null for "no such place",
   * or 'fail' for a lookup that throws. A name not listed finds nothing.
   */
  geocode: Record<string, GeocodeStub>;
}

export type GeocodeStub = { location: WeatherLocation | null; delayMs?: number } | 'fail';

/**
 * What the stubs keep in the main process, on `globalThis.__switchboardE2E`.
 * Evaluated functions are serialised into main, so they reach it through this
 * global rather than through a closure.
 */
interface StubState extends HostStubs {
  opened: string[];
  calls: HostStubCalls;
}

/** How often the renderer asked the stubs for something, by channel. */
export interface HostStubCalls {
  getUsage: number;
  installUpdate: number;
}

type WithStubs = typeof globalThis & { __switchboardE2E: StubState };

export const DEFAULT_STUBS: HostStubs = {
  usage: STUB_USAGE,
  usageFails: false,
  update: null,
  installUpdate: 'pending',
  sleepDisabled: false,
  browseFolder: null,
  geocode: {},
};

/** Replace the host-facing IPC handlers. Call before the renderer (re)loads. */
export async function installHostStubs(app: ElectronApplication, stubs: HostStubs): Promise<void> {
  await app.evaluate(({ ipcMain }, { stubs, channels }) => {
    const state: StubState = { ...stubs, opened: [], calls: { getUsage: 0, installUpdate: 0 } };
    (globalThis as WithStubs).__switchboardE2E = state;

    const replace = (channel: string, handler: (...args: unknown[]) => unknown): void => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...args) => handler(...args));
    };

    replace(channels.getUsage, () => {
      state.calls.getUsage++;
      if (state.usageFails) throw new Error('usage unavailable');
      return state.usage;
    });
    replace(channels.getUpdate, () => state.update);
    replace(channels.installUpdate, () => {
      state.calls.installUpdate++;
      return state.installUpdate === 'pending' ? new Promise(() => {}) : state.installUpdate;
    });
    replace(channels.getSleepDisabled, () => state.sleepDisabled);
    replace(channels.setSleepDisabled, (disabled) => {
      state.sleepDisabled = !!disabled;
      return state.sleepDisabled;
    });
    replace(channels.browseFolder, () => state.browseFolder);
    // Both weather channels would reach Open-Meteo. The forecast is never
    // needed (a fixture that turns weather on gets no sky), and the lookup
    // answers from the table above.
    replace(channels.getWeather, () => null);
    replace(channels.geocodeWeatherLocation, async (name) => {
      const stub = state.geocode[String(name)];
      if (stub === 'fail') throw new Error('geocoding is offline');
      if (!stub) return null;
      if (stub.delayMs) await new Promise(resolve => setTimeout(resolve, stub.delayMs));
      return stub.location;
    });
    replace(channels.openExternal, (url) => {
      state.opened.push(String(url));
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

/** How often each counted stub has been called since the app launched. */
export async function hostStubCalls(app: ElectronApplication): Promise<HostStubCalls> {
  return await app.evaluate(() => {
    return { ...(globalThis as WithStubs).__switchboardE2E.calls };
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
