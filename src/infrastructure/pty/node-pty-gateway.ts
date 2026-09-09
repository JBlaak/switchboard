/**
 * node-pty behind the TerminalGateway port.
 *
 * Two things here are not just delegation. Signalling reaches the whole process
 * group rather than one pid, because a session is a shell wrapping `claude`
 * (sometimes with a pre-launch command in between) and signalling the shell
 * leaves the rest running. And liveness is answered from the pid, because the
 * exit event is not guaranteed to arrive.
 */
import * as pty from 'node-pty';
import os from 'node:os';
import type {
  PtyHandle, SpawnSpec, TerminalGateway,
} from '../../application/ports/terminal-gateway';

/**
 * The environment child processes inherit.
 *
 * Electron's own variables are stripped: they make a nested Electron app — or
 * node-pty inside one — malfunction, and a session that starts an editor or a
 * dev server is exactly that case. NODE_OPTIONS goes for the same reason, and
 * the desktop-session leftovers because they confuse terminal detection.
 */
export function cleanChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      !key.startsWith('ELECTRON_') &&
      !key.startsWith('GOOGLE_API_KEY') &&
      key !== 'NODE_OPTIONS' &&
      key !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
      key !== 'WT_SESSION'),
  ) as Record<string, string>;
}

/** node-pty's IPty, plus the internal disposal flag it does not expose. */
type NodePty = pty.IPty & { _isDisposed?: boolean };

class NodePtyHandle implements PtyHandle {
  constructor(readonly process: NodePty) {}

  get pid(): number | undefined {
    return this.process.pid;
  }

  get disposed(): boolean {
    // node-pty has no public equivalent; reading it is what stops a write
    // landing in a PTY whose process is already gone.
    return this.process._isDisposed === true;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  onData(listener: (data: string) => void): void {
    this.process.onData(listener);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.process.onExit(listener);
  }

  kill(signal?: NodeJS.Signals): void {
    this.process.kill(signal);
  }
}

/** Injected in tests; the real one is `process.kill`. */
export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface NodePtyGatewayOptions {
  kill?: KillFn;
  env?: NodeJS.ProcessEnv;
}

export class NodePtyGateway implements TerminalGateway {
  readonly baseEnv: Record<string, string>;
  readonly #kill: KillFn;

  constructor(options: NodePtyGatewayOptions = {}) {
    this.baseEnv = cleanChildEnv(options.env);
    this.#kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  }

  spawn(spec: SpawnSpec): PtyHandle {
    return new NodePtyHandle(pty.spawn(spec.file, [...spec.args], {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    }) as NodePty);
  }

  /**
   * Signal the process group.
   *
   * forkpty() calls setsid() in the child, so its pid doubles as its
   * process-group id and a negative pid reaches everything under it — which is
   * what stops `claude` outliving the row that owns it.
   *
   * The fallback covers Windows, where there is no process group, and the case
   * where the group leader has already been reaped; node-pty's own kill closes
   * the job object there, which has the same effect.
   */
  signalTree(handle: PtyHandle, signal: NodeJS.Signals): boolean {
    const pid = handle.pid;
    if (!pid) return false;
    try {
      this.#kill(-pid, signal);
      return true;
    } catch {
      // No process group to signal.
    }
    try {
      handle.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Is the process still there?
   *
   * Signal 0 tests for existence without delivering anything. A zombie awaiting
   * reap still answers, so this only reads false once the process is genuinely
   * gone. EPERM means it exists but is not ours to signal — still alive.
   */
  isAlive(handle: PtyHandle): boolean {
    const pid = handle.pid;
    if (!pid) return false;
    try {
      this.#kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /** Where a process is spawned when the project directory is not usable. */
  get homeDir(): string {
    return os.homedir();
  }
}
