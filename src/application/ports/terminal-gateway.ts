/**
 * Pseudo-terminals, as a dependency.
 *
 * A session *is* a process on a PTY, so this is the port the session lifecycle
 * is written against. It covers three things node-pty does not present as one
 * idea: running the process, signalling the whole tree it started, and finding
 * out whether it is still there.
 */

export interface SpawnSpec {
  file: string;
  args: readonly string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

/** A running PTY. */
export interface PtyHandle {
  readonly pid: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  /**
   * Signal this process alone.
   *
   * The fallback for `signalTree`, and the only option on Windows, where there
   * is no process group to reach.
   */
  kill(signal?: NodeJS.Signals): void;
  /** True once the handle can no longer be written to. */
  readonly disposed: boolean;
}

export interface TerminalGateway {
  spawn(spec: SpawnSpec): PtyHandle;

  /**
   * Signal the whole process tree, not just the process on the PTY.
   *
   * Sessions run as `zsh -l -i -c 'claude …'`, and a preLaunchCmd
   * ("aws-vault exec … --") puts another process in between, so signalling one
   * pid leaves `claude` running with nothing left to stop it.
   *
   * Answers false when there was nothing to signal.
   */
  signalTree(handle: PtyHandle, signal: NodeJS.Signals): boolean;

  /**
   * Is the process still there?
   *
   * The exit event is not enough on its own: a process killed from outside can
   * die without one arriving, leaving a row stuck on "Running" for the life of
   * the app. The pid is the ground truth.
   */
  isAlive(handle: PtyHandle): boolean;

  /**
   * The environment a child should inherit, with this app's own variables
   * stripped — an Electron app's environment makes nested Electron apps (and
   * node-pty inside them) malfunction.
   */
  readonly baseEnv: Record<string, string>;
}
