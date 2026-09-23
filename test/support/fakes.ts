/**
 * Test doubles for the ports.
 *
 * One of the points of the ports is that a double is a few lines rather than a
 * mocking framework, and that a test can assert on what a use case *asked for*
 * rather than on what the OS did. These are shared because several tests want
 * the same fake clock and the same recording gateway.
 */
import type { RemoteStatusPayload } from '../../src/domain/remote/remote-status';
import type { Timers } from '../../src/application/ports/clock';
import type { IdeBridge, IdeBridgeHandle } from '../../src/application/ports/ide-bridge';
import type { Logger } from '../../src/application/ports/logger';
import type { RendererGateway } from '../../src/application/ports/renderer-gateway';
import type {
  PtyHandle, SpawnSpec, TerminalGateway,
} from '../../src/application/ports/terminal-gateway';

export const silentLog: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
};

// ── A fake clock ──

export interface FakeTimers extends Timers {
  /** Run every callback that is currently due; each may schedule the next. */
  tick(): void;
  /** How many callbacks are still pending. */
  readonly pending: number;
}

/**
 * Timers that never touch the real clock.
 *
 * `tick` runs one *round*: the callbacks scheduled before it was called. That
 * is what lets an escalation ladder be walked a rung at a time, which is the
 * whole reason the delays are injected.
 */
export function fakeTimers(): FakeTimers {
  let seq = 0;
  const scheduled = new Map<number, () => void>();

  return {
    setTimeout(fn) {
      const id = ++seq;
      scheduled.set(id, fn);
      return id;
    },
    clearTimeout(handle) {
      if (handle != null) scheduled.delete(handle as number);
    },
    setInterval(fn) {
      const id = ++seq;
      scheduled.set(id, fn);
      return id;
    },
    clearInterval(handle) {
      if (handle != null) scheduled.delete(handle as number);
    },
    tick() {
      for (const [id, fn] of [...scheduled]) {
        scheduled.delete(id);
        fn();
      }
    },
    get pending() {
      return scheduled.size;
    },
  };
}

// ── A fake PTY ──

export interface FakePty extends PtyHandle {
  /** Every `kill(signal)` this handle saw, in order. */
  readonly kills: (NodeJS.Signals | undefined)[];
  /** Everything written to it. */
  readonly writes: string[];
  /** Push a chunk as if the process had printed it. */
  emitData(data: string): void;
  /** End it, as if the process had exited. */
  emitExit(exitCode: number, signal?: number): void;
}

export function fakePty(pid = 4242): FakePty {
  return makePty(pid);
}

/**
 * A handle whose process is already gone.
 *
 * `fakePty(undefined)` cannot express this: a JS default parameter applies to
 * `undefined`, so it would hand back the default pid.
 */
export function pidlessPty(): FakePty {
  return makePty(undefined);
}

function makePty(pid: number | undefined): FakePty {
  const kills: (NodeJS.Signals | undefined)[] = [];
  const writes: string[] = [];
  let onData: ((data: string) => void) | null = null;
  let onExit: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  return {
    pid,
    disposed: false,
    kills,
    writes,
    write(data) { writes.push(data); },
    resize() {},
    onData(listener) { onData = listener; },
    onExit(listener) { onExit = listener; },
    kill(signal) { kills.push(signal); },
    emitData(data) { onData?.(data); },
    emitExit(exitCode, signal) { onExit?.({ exitCode, signal }); },
  };
}

// ── A fake terminal gateway ──

export interface FakeTerminals extends TerminalGateway {
  /** Every spawn it was asked for. */
  readonly spawns: SpawnSpec[];
  /** Every `signalTree` call, as [pid, signal]. */
  readonly signals: [number | undefined, NodeJS.Signals][];
  /** The pids it should report as still running. */
  readonly alive: Set<number>;
  /** The handle the next spawn will return. */
  nextPty: FakePty;
}

export function fakeTerminals(alive: Iterable<number> = [4242]): FakeTerminals {
  const spawns: SpawnSpec[] = [];
  const signals: [number | undefined, NodeJS.Signals][] = [];
  const aliveSet = new Set(alive);

  const gateway: FakeTerminals = {
    spawns,
    signals,
    alive: aliveSet,
    nextPty: fakePty(),
    baseEnv: {},
    spawn(spec) {
      spawns.push(spec);
      return gateway.nextPty;
    },
    signalTree(handle, signal) {
      signals.push([handle.pid, signal]);
      return true;
    },
    isAlive(handle) {
      return handle.pid !== undefined && aliveSet.has(handle.pid);
    },
  };
  return gateway;
}

// ── A recording renderer gateway ──

/** One event the fake gateway saw: the method name and its arguments. */
export type RecordedEvent = [string, ...unknown[]];

export interface FakeRenderer extends RendererGateway {
  readonly events: RecordedEvent[];
  /** Just the events of one kind, for the common single-channel assertion. */
  only(kind: string): RecordedEvent[];
}

export function fakeRenderer(): FakeRenderer {
  const events: RecordedEvent[] = [];
  const record = (kind: string) => (...args: unknown[]): void => {
    events.push([kind, ...args]);
  };

  return {
    events,
    only: (kind) => events.filter(e => e[0] === kind),
    attached: true,
    terminalData: record('terminalData'),
    processExited: record('processExited'),
    sessionDetected: record('sessionDetected'),
    sessionForked: record('sessionForked'),
    cliBusyState: record('cliBusyState'),
    terminalNotification: record('terminalNotification'),
    remoteStatus: record('remoteStatus') as (id: string, s: RemoteStatusPayload) => void,
    projectsChanged: record('projectsChanged'),
    statusUpdate: record('statusUpdate'),
    fullscreenChanged: record('fullscreenChanged'),
    fileChanged: record('fileChanged'),
    updaterEvent: record('updaterEvent'),
    openDiff: record('openDiff') as FakeRenderer['openDiff'],
    openFile: record('openFile') as FakeRenderer['openFile'],
    closeAllDiffs: record('closeAllDiffs'),
    closeDiffTab: record('closeDiffTab'),
  };
}

// ── A fake IDE bridge ──

export interface FakeIdeBridge extends IdeBridge {
  /** The sessions whose bridge was stopped, in order. */
  readonly stopped: string[];
  /** The re-keys it was told about. */
  readonly rekeyed: [string, string][];
}

export function fakeIdeBridge(): FakeIdeBridge {
  const stopped: string[] = [];
  const rekeyed: [string, string][] = [];

  return {
    stopped,
    rekeyed,
    start: async (): Promise<IdeBridgeHandle> => ({ port: 1234, authToken: 'token' }),
    stop(sessionId) { stopped.push(sessionId); },
    stopAll() {},
    rekey(oldId, newId) { rekeyed.push([oldId, newId]); },
    resolveDiff() {},
    cleanStaleLocks() {},
  };
}
