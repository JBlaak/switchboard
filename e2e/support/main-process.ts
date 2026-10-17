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
 *   app, write the clipboard, prompt for an administrator password). Their
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
import { EVENT, INVOKE, SEND } from '../../src/ipc/channels';
import type { SessionWorkDiff, SessionWorkSnapshot } from '../../src/domain/session-work/model';
import type { ActionRequest } from '../../src/domain/session-work/actions';
import type { CommentRequest, ReviewRequest } from '../../src/domain/session-work/review';
import type { RemoteStatusPayload } from '../../src/domain/remote/remote-status';
import type { UpdateNotice } from '../../src/domain/update/release';
import type { Usage } from '../../src/domain/usage/usage';
import type { Weather, WeatherLocation } from '../../src/domain/weather/weather';
import type { Plan } from '../../src/domain/plan/model';
import type { SessionPlans } from '../../src/application/services/plan-service';

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
  /** Whether `pmset` would report sleep as disabled; null is a host that cannot say. */
  sleepDisabled: boolean | null;
  /**
   * How long the sleep switch takes to answer, standing in for the password
   * prompt the real one may show.
   */
  sleepPromptDelayMs: number;
  /** True when that prompt is cancelled: the switch answers with the state unchanged. */
  sleepPromptCancelled: boolean;
  /** What the folder picker "chooses"; null is a cancelled dialog. */
  browseFolder: string | null;
  /**
   * What `getWeather` answers: null is no sky (weather switched off, or not
   * fetched), and `'never'` a fetch that never comes back, for the timeouts
   * that guard it.
   */
  weather: Weather | null | 'never';
  /**
   * What looking up a weather city answers, by the name typed: a location
   * (after `delayMs`, to hold a lookup in flight), null for "no such place",
   * or 'fail' for a lookup that throws. A name not listed finds nothing.
   */
  geocode: Record<string, GeocodeStub>;
  /**
   * The Session work page's back end, standing in for git and `gh`; null
   * leaves the real service, which finds no repository in the fixture home.
   */
  sessionWork: SessionWorkStub | null;
  /**
   * The Plan tab's back end, standing in for `gh`; null leaves the real
   * service, which finds no repository in the fixture home.
   */
  plans: PlansStub | null;
}

/** What the plan channels answer: a session's plans, one plan by its issue, and the sessions that own issues. */
export interface PlansStub {
  /** By session id; a session not here answers null, as one outside a repository does. */
  sessionPlans: Record<string, SessionPlans>;
  /** By `owner/repo#n`. */
  plans?: Record<string, Plan>;
  /** By repository: `owner/repo#n` → the session that owns it. */
  issueSessions?: Record<string, Record<string, string>>;
}

/**
 * Which sessions the page can open for, and the snapshot it opens with. A
 * session with no snapshot opens on the skeleton and stays there.
 */
export interface SessionWorkStub {
  canOpen: string[];
  snapshots: Record<string, SessionWorkSnapshot>;
  /** What `getSessionWorkDiff` answers, by item id: an item not here has no changes, and 'never' never answers. */
  diffs?: Record<string, SessionWorkDiff | 'never'>;
  /**
   * Why every action is refused; unset queues each one, answering `act-<n>`.
   * Either way the request is recorded (see `sessionWorkActions`).
   */
  refuseActions?: string;
  /** Why every review write (a comment, submit, discard) is refused; unset, each one goes through. */
  refuseReview?: string
  /** What the Checks panel's log request answers, by check run URL; a URL not here has no log. */
  checkLogs?: Record<string, string>;
  /**
   * What `sessionWorkImage` answers, by `imageStubKey`, as base64: the bytes
   * the real service would read for that side. A side not here has none.
   */
  images?: Record<string, string>;
}

/** Where `SessionWorkStub.images` files one side of an image in an item's diff. */
export function imageStubKey(itemId: string, path: string, side: 'before' | 'after'): string {
  return [itemId, path, side].join('\n');
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
  clipboard: string[];
  /** Every session the renderer told main its Session work page closed for, in order. */
  sessionWorkClosed: string[];
  /** Every action the page asked main for, in order. */
  sessionWorkActions: ActionRequest[];
  /** Every queued action the page asked main to cancel, by id. */
  sessionWorkCancels: string[];
  /** Every write to your review the page asked main for, in order. */
  sessionWorkReviews: ReviewWrite[];
}

/** A comment added to the pending review, or the review finished. */
export type ReviewWrite = { comment: CommentRequest } | { review: ReviewRequest };

/** How often the renderer asked the stubs for something, by channel. */
export interface HostStubCalls {
  getUsage: number;
  installUpdate: number;
  getWeather: number;
}

type WithStubs = typeof globalThis & { __switchboardE2E: StubState };

export const DEFAULT_STUBS: HostStubs = {
  usage: STUB_USAGE,
  usageFails: false,
  update: null,
  installUpdate: 'pending',
  sleepDisabled: false,
  sleepPromptDelayMs: 0,
  sleepPromptCancelled: false,
  browseFolder: null,
  weather: null,
  geocode: {},
  sessionWork: null,
  plans: null,
};

/** Replace the host-facing IPC handlers. Call before the renderer (re)loads. */
export async function installHostStubs(app: ElectronApplication, stubs: HostStubs): Promise<void> {
  await app.evaluate(({ ipcMain }, { stubs, channels, send }) => {
    const state: StubState = {
      ...stubs, opened: [], calls: { getUsage: 0, installUpdate: 0, getWeather: 0 }, clipboard: [], sessionWorkClosed: [],
      sessionWorkActions: [], sessionWorkCancels: [], sessionWorkReviews: [],
    };
    (globalThis as WithStubs).__switchboardE2E = state;

    // Heard beside the real handler, which ignores a close for a page it never opened.
    ipcMain.on(send.sessionWorkClose, (_event, sessionId) => {
      state.sessionWorkClosed.push(String(sessionId));
    });
    if (state.sessionWork) {
      const work = state.sessionWork;
      ipcMain.removeHandler(channels.sessionWorkCanOpen);
      ipcMain.handle(channels.sessionWorkCanOpen, (_event, sessionId) => work.canOpen.includes(String(sessionId)));
      ipcMain.removeHandler(channels.sessionWorkOpen);
      ipcMain.handle(channels.sessionWorkOpen, (_event, sessionId) => {
        const snapshot = work.snapshots[String(sessionId)];
        // No snapshot: main is still reading git, and the page stays a skeleton.
        return snapshot ?? new Promise(() => {});
      });
      ipcMain.removeHandler(channels.sessionWorkDiff);
      ipcMain.handle(channels.sessionWorkDiff, (_event, request: { itemId: string }) => {
        const diff = work.diffs?.[String(request?.itemId)];
        if (diff === 'never') return new Promise(() => {});
        return diff ?? { files: [], source: null };
      });
      // The page's actions would type into the session through the real queue,
      // which needs the real page; recorded here instead, and the test pushes
      // the snapshot that shows what the queue would have done.
      ipcMain.removeHandler(channels.sessionWorkAction);
      ipcMain.handle(channels.sessionWorkAction, (_event, request: ActionRequest) => {
        state.sessionWorkActions.push(request);
        if (work.refuseActions) return { ok: false, reason: work.refuseActions };
        return { ok: true, activityId: 'act-' + state.sessionWorkActions.length };
      });
      ipcMain.removeHandler(channels.sessionWorkCancel);
      ipcMain.handle(channels.sessionWorkCancel, (_event, activityId) => {
        state.sessionWorkCancels.push(String(activityId));
        return { ok: true };
      });
      // Your review would be written to GitHub; recorded here instead.
      ipcMain.removeHandler(channels.sessionWorkComment);
      ipcMain.handle(channels.sessionWorkComment, (_event, request: CommentRequest) => {
        state.sessionWorkReviews.push({ comment: request });
        return work.refuseReview ? { ok: false, reason: work.refuseReview } : { ok: true };
      });
      ipcMain.removeHandler(channels.sessionWorkReview);
      ipcMain.handle(channels.sessionWorkReview, (_event, request: ReviewRequest) => {
        state.sessionWorkReviews.push({ review: request });
        return work.refuseReview ? { ok: false, reason: work.refuseReview } : { ok: true };
      })
      // The real one would ask `gh` for the log.
      ipcMain.removeHandler(channels.sessionWorkCheckLog);
      ipcMain.handle(channels.sessionWorkCheckLog, (_event, request: { checkRunUrl: string }) =>
        work.checkLogs?.[String(request?.checkRunUrl)] ?? null);
      // The real one reads the bytes at the commits the diff was made from.
      ipcMain.removeHandler(channels.sessionWorkImage);
      ipcMain.handle(channels.sessionWorkImage, (_event, request: { itemId: string; path: string; side: string }) => {
        const bytes = work.images?.[[request?.itemId, request?.path, request?.side].join('\n')];
        return bytes ? new Uint8Array(Buffer.from(bytes, 'base64')) : null;
      });
    }

    if (state.plans) {
      const plans = state.plans;
      // Read at each call, so `setHostStub(app, 'plans', …)` changes what the next poll answers.
      const now = (): PlansStub => state.plans ?? plans;
      ipcMain.removeHandler(channels.planSessionPlans);
      ipcMain.handle(channels.planSessionPlans, (_event, sessionId) => now().sessionPlans[String(sessionId)] ?? null);
      ipcMain.removeHandler(channels.planGet);
      ipcMain.handle(channels.planGet, (_event, repo, number) => now().plans?.[String(repo) + '#' + String(number)] ?? null);
      ipcMain.removeHandler(channels.planProjectPlans);
      ipcMain.handle(channels.planProjectPlans, () => []);
      ipcMain.removeHandler(channels.planIssueSessions);
      ipcMain.handle(channels.planIssueSessions, (_event, repo) => plans.issueSessions?.[String(repo)] ?? {});
    }

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
    replace(channels.setSleepDisabled, async (disabled) => {
      await new Promise(resolve => setTimeout(resolve, state.sleepPromptDelayMs));
      if (!state.sleepPromptCancelled) state.sleepDisabled = !!disabled;
      return state.sleepDisabled;
    });
    replace(channels.browseFolder, () => state.browseFolder);
    // Both weather channels would reach Open-Meteo. The forecast answers
    // the `weather` stub (none, unless a test dresses Patch for one), and
    // the lookup answers from the table above.
    replace(channels.getWeather, () => {
      state.calls.getWeather++;
      return state.weather === 'never' ? new Promise(() => {}) : state.weather;
    });
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
    // The real clipboard is the user's: a test that copies must not overwrite it.
    replace(channels.writeClipboard, (text) => {
      state.clipboard.push(String(text));
    });
    replace(channels.openRepository, (projectPath) => {
      state.opened.push('repository:' + String(projectPath));
      return true;
    });
  }, { stubs, channels: INVOKE, send: SEND });
}

/** The sessions whose Session work page the renderer told main it closed, in order. */
export async function sessionWorkClosed(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(() => {
    return [...(globalThis as WithStubs).__switchboardE2E.sessionWorkClosed];
  });
}

/** The actions the page asked main for, in order. */
export async function sessionWorkActions(app: ElectronApplication): Promise<ActionRequest[]> {
  return await app.evaluate(() => {
    return [...(globalThis as WithStubs).__switchboardE2E.sessionWorkActions];
  });
}

/** The queued actions the page asked main to cancel, by id. */
export async function sessionWorkCancels(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(() => {
    return [...(globalThis as WithStubs).__switchboardE2E.sessionWorkCancels];
  });
}

/** Every write to your review the Session work page asked main for, in order. */
export async function sessionWorkReviews(app: ElectronApplication): Promise<ReviewWrite[]> {
  return await app.evaluate(() => {
    return [...(globalThis as WithStubs).__switchboardE2E.sessionWorkReviews];
  });
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

/**
 * Make every search fail in the main process, as an index that cannot parse a
 * query would if main did not already answer it with no results.
 */
export async function breakSearch(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => { throw new Error('fts5: syntax error'); });
  }, INVOKE.search);
}

/** How often each counted stub has been called since the app launched. */
export async function hostStubCalls(app: ElectronApplication): Promise<HostStubCalls> {
  return await app.evaluate(() => {
    return { ...(globalThis as WithStubs).__switchboardE2E.calls };
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

/**
 * Make every "stop session" request fail with `error`, the way a PTY that
 * refuses to die would. For the paths that have to give up part-way — archiving
 * a whole project stops at the first session it cannot stop.
 */
export async function failStopSession(app: ElectronApplication, error: string): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, error }) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => ({ ok: false, error }));
  }, { channel: INVOKE.stopSession, error });
}

/**
 * Answer every "reconnect now" request with `result` instead of acting on it,
 * and remember which sessions asked. For the card's Retry button: what the
 * click asks main for is the thing under test, and a real early redial would
 * race the backoff it short-circuits.
 */
export async function stubReconnectRemote(app: ElectronApplication, result: { ok: boolean }): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, result }) => {
    const state = (globalThis as typeof globalThis & { __switchboardE2E: { reconnects?: string[] } }).__switchboardE2E;
    state.reconnects = [];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, sessionId) => {
      state.reconnects!.push(String(sessionId));
      return result;
    });
  }, { channel: INVOKE.reconnectRemote, result });
}

/** The sessions the renderer asked to reconnect since `stubReconnectRemote`. */
export async function reconnectRequests(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(() => {
    const state = (globalThis as typeof globalThis & { __switchboardE2E: { reconnects?: string[] } }).__switchboardE2E;
    return [...(state.reconnects ?? [])];
  });
}

/** Where the main window sits on screen, [x, y]. */
export async function windowPosition(app: ElectronApplication): Promise<number[]> {
  return await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getPosition());
}
