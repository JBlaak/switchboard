/**
 * Test doubles for the ports.
 *
 * One of the points of the ports is that a double is a few lines rather than a
 * mocking framework, and that a test can assert on what a use case *asked for*
 * rather than on what the OS did. These are shared because several tests want
 * the same fake clock and the same recording gateway.
 */
import path from 'node:path';
import type { RemoteStatusPayload } from '../../src/domain/remote/remote-status';
import type { Timers } from '../../src/application/ports/clock';
import type {
  DirEntry, FileStat, FileSystem, WatchListener, WatchOptions, Watcher,
} from '../../src/application/ports/file-system';
import type { IdeBridge, IdeBridgeHandle } from '../../src/application/ports/ide-bridge';
import type { Logger } from '../../src/application/ports/logger';
import type { ExecOptions, ExecResult, ProcessRunner } from '../../src/application/ports/process-runner';
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

// ── A scripted process runner ──

export interface FakeProcessRunner extends ProcessRunner {
  /** Every exec it was asked for, in order. */
  readonly calls: { file: string; args: string[]; opts: ExecOptions }[];
}

/**
 * A runner that answers from a script instead of starting anything.
 *
 * The script sees the command and decides what it "printed"; returning
 * undefined means the test did not expect that command, and the runner answers
 * with exit 127 and a stderr that says so — a loud failure in the assertion
 * that follows, rather than a service quietly treating empty output as success.
 */
export function fakeProcessRunner(
  script: (file: string, args: readonly string[], stdin?: string) => ExecResult | undefined,
): FakeProcessRunner {
  const calls: { file: string; args: string[]; opts: ExecOptions }[] = [];

  return {
    calls,
    async exec(file, args, opts) {
      calls.push({ file, args: [...args], opts });
      return script(file, args, opts.stdin) ?? {
        stdout: '',
        stderr: `fakeProcessRunner: no script match for \`${[file, ...args].join(' ')}\``,
        code: 127,
      };
    },
  };
}

// ── An in-memory filesystem ──

export interface FakeFileSystem extends FileSystem {
  /** Every `writeText`, as [path, content]. */
  readonly writes: [string, string][];
  /** Report a change to every watcher whose target covers `path`. */
  emitChange(path: string, eventType?: string): void;
}

/** The one mtime every file has: tests that care about time inject a clock, not a filesystem. */
const FAKE_MTIME_ISO = '2024-01-01T00:00:00.000Z';

/**
 * The FileSystem port over a map of paths.
 *
 * Always posix, whatever the host: the paths a test writes down are the paths
 * it should read back, and a fake that switched separators on Windows would
 * have the tests asserting on the CI runner rather than on the code. Relative
 * paths resolve against `homeDir`.
 *
 * Seeding a file creates its ancestors, the way a test would expect; after
 * that it behaves like the real adapter — `readText` on a missing file throws,
 * `writeText` into a directory that was never made throws, `stat` on a missing
 * path is null — so a service that forgets a `makeDir` fails here too.
 *
 * `links` seeds symlinks. A listing reports one as neither file nor directory,
 * which is what `readdirSync(withFileTypes)` does — it reads the link, not what
 * the link points at — and nothing here follows one, so a link's target is not
 * modelled at all.
 */
export function fakeFileSystem(
  seed: { files?: Record<string, string>; dirs?: string[]; links?: string[] } = {},
): FakeFileSystem {
  const homeDir = '/home/test';
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  const links = new Set<string>();
  const writes: [string, string][] = [];
  const watchers = new Set<{ target: string; recursive: boolean; listener: WatchListener }>();

  const resolve = (target: string): string =>
    path.posix.normalize(path.posix.isAbsolute(target) ? target : path.posix.join(homeDir, target));

  const addDirWithAncestors = (dir: string): void => {
    for (let current = dir; !dirs.has(current); current = path.posix.dirname(current)) {
      dirs.add(current);
    }
  };

  const fsError = (code: string, syscall: string, target: string): Error => {
    const messages: Record<string, string> = {
      ENOENT: 'no such file or directory',
      EISDIR: 'illegal operation on a directory',
      ENOTDIR: 'not a directory',
    };
    const error = new Error(`${code}: ${messages[code] ?? code}, ${syscall} '${target}'`);
    (error as NodeJS.ErrnoException).code = code;
    return error;
  };

  const isInside = (parent: string, child: string): boolean => {
    const from = resolve(parent);
    const to = resolve(child);
    if (to === from) return true;
    return to.startsWith(from.endsWith('/') ? from : from + '/');
  };

  /** Everything at or under `root`, files and directories alike. */
  const descendants = (root: string): string[] =>
    [...files.keys(), ...dirs].filter(p => p !== '/' && isInside(root, p));

  for (const dir of seed.dirs ?? []) addDirWithAncestors(resolve(dir));
  for (const [file, content] of Object.entries(seed.files ?? {})) {
    const resolved = resolve(file);
    addDirWithAncestors(path.posix.dirname(resolved));
    files.set(resolved, content);
  }
  for (const link of seed.links ?? []) {
    const resolved = resolve(link);
    addDirWithAncestors(path.posix.dirname(resolved));
    links.add(resolved);
  }

  return {
    writes,
    separator: '/',
    homeDir,

    exists(target) {
      const resolved = resolve(target);
      return files.has(resolved) || dirs.has(resolved) || links.has(resolved);
    },

    isDirectory(target) {
      return dirs.has(resolve(target));
    },

    readText(target) {
      const resolved = resolve(target);
      const content = files.get(resolved);
      if (content !== undefined) return content;
      throw fsError(dirs.has(resolved) ? 'EISDIR' : 'ENOENT', 'open', target);
    },

    writeText(target, content) {
      const resolved = resolve(target);
      if (dirs.has(resolved)) throw fsError('EISDIR', 'open', target);
      if (!dirs.has(path.posix.dirname(resolved))) throw fsError('ENOENT', 'open', target);
      files.set(resolved, content);
      writes.push([resolved, content]);
    },

    readSlice(target, range) {
      const resolved = resolve(target);
      const content = files.get(resolved);
      if (content === undefined) throw fsError(dirs.has(resolved) ? 'EISDIR' : 'ENOENT', 'open', target);
      if (range.length <= 0) return '';
      // Byte offsets, as the real adapter reads them.
      return Buffer.from(content, 'utf8').subarray(range.start, range.start + range.length).toString('utf8');
    },

    readDir(target): DirEntry[] {
      const resolved = resolve(target);
      if (!dirs.has(resolved)) throw fsError(files.has(resolved) ? 'ENOTDIR' : 'ENOENT', 'scandir', target);
      const entries: DirEntry[] = [];
      for (const file of files.keys()) {
        if (path.posix.dirname(file) === resolved) {
          entries.push({
            name: path.posix.basename(file), isFile: true, isDirectory: false, isSymbolicLink: false,
          });
        }
      }
      for (const dir of dirs) {
        if (dir !== resolved && path.posix.dirname(dir) === resolved) {
          entries.push({
            name: path.posix.basename(dir), isFile: false, isDirectory: true, isSymbolicLink: false,
          });
        }
      }
      for (const link of links) {
        if (path.posix.dirname(link) === resolved) {
          entries.push({
            name: path.posix.basename(link), isFile: false, isDirectory: false, isSymbolicLink: true,
          });
        }
      }
      // Code-point order, not localeCompare: the same on every CI runner.
      return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    stat(target): FileStat | null {
      const resolved = resolve(target);
      const content = files.get(resolved);
      if (content === undefined && !dirs.has(resolved)) return null;
      return {
        modifiedIso: FAKE_MTIME_ISO,
        createdIso: FAKE_MTIME_ISO,
        mtimeMs: Date.parse(FAKE_MTIME_ISO),
        size: content === undefined ? 0 : Buffer.byteLength(content, 'utf8'),
      };
    },

    makeDir(target) {
      const resolved = resolve(target);
      if (files.has(resolved)) throw fsError('ENOTDIR', 'mkdir', target);
      addDirWithAncestors(resolved);
    },

    remove(target) {
      // `force: true` semantics: removing what is not there is not an error.
      for (const entry of descendants(resolve(target))) {
        files.delete(entry);
        dirs.delete(entry);
      }
    },

    rename(from, to) {
      const source = resolve(from);
      const destination = resolve(to);
      if (!files.has(source) && !dirs.has(source)) throw fsError('ENOENT', 'rename', from);
      if (!dirs.has(path.posix.dirname(destination))) throw fsError('ENOENT', 'rename', to);
      for (const entry of descendants(source)) {
        const moved = destination + entry.slice(source.length);
        if (files.has(entry)) {
          files.set(moved, files.get(entry)!);
          files.delete(entry);
        } else {
          dirs.delete(entry);
          dirs.add(moved);
        }
      }
    },

    watch(target, options: WatchOptions, listener: WatchListener): Watcher {
      const resolved = resolve(target);
      if (!files.has(resolved) && !dirs.has(resolved)) throw fsError('ENOENT', 'watch', target);
      const entry = { target: resolved, recursive: options.recursive === true, listener };
      watchers.add(entry);
      return { close: () => { watchers.delete(entry); } };
    },

    emitChange(target, eventType = 'change') {
      const changed = resolve(target);
      for (const { target: watched, recursive, listener } of [...watchers]) {
        if (changed === watched) {
          // As fs.watch does for a watched file: the name reported is its own.
          listener(eventType, path.posix.basename(changed));
        } else if (isInside(watched, changed)) {
          const relative = changed.slice(watched === '/' ? 1 : watched.length + 1);
          // A plain watch on a directory only sees its direct children.
          if (recursive || !relative.includes('/')) listener(eventType, relative);
        }
      }
    },

    join: (...parts) => path.posix.join(...parts),
    resolve,
    basename: (target, ext) => path.posix.basename(target, ext),
    dirname: (target) => path.posix.dirname(target),
    isInside,
  };
}
