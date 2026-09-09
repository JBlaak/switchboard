/**
 * A child process run to completion, as a dependency.
 *
 * The app already starts processes in several places — the scheduler runs
 * `claude` fire-and-forget, shell discovery shells out to `wsl.exe --list`, the
 * credential reader asks `security` for a password — and each site rolls its own
 * spawn-and-collect. This is the one shape they have in common, for a service
 * (the git integration first) that needs a command's output and, living in the
 * application layer, cannot reach for `node:child_process` itself.
 *
 * A non-zero exit is a result, not an error. For the commands this is used for
 * it is usually an answer: `git check-ignore` exits 1 to mean "not ignored",
 * `git diff --quiet` exits 1 to mean "there are changes", and a port that threw
 * on those would push every caller into a catch block that picks the error
 * apart to recover the stdout it was after. Rejecting is reserved for the cases
 * where there is no result to report: the executable could not be started, or
 * it had to be killed because it ran past its timeout.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** The exit code. Non-zero is reported here, never thrown. */
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  /**
   * Required rather than defaulted: a command that hangs (git waiting on a
   * credential prompt nobody will answer) would otherwise hang its caller too,
   * and the right bound for `git status` is not the right bound for `git fetch`.
   */
  timeoutMs: number;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Laid over the environment the adapter gives every child. */
  env?: Record<string, string>;
}

export interface ProcessRunner {
  /**
   * Run `file` with `args` and wait for it to exit.
   *
   * Resolves on ANY exit code — callers decide what non-zero means (e.g.
   * `git check-ignore` exits 1 for "no match"). Rejects only when the process
   * could not be spawned or the timeout fired.
   */
  exec(file: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult>;
}
