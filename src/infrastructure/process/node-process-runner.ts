/**
 * Node's execFile behind the ProcessRunner port.
 *
 * `execFile` rather than `spawn` because it already collects both output
 * streams and enforces a timeout, and rather than `exec` because the arguments
 * go to the process as given, with no shell in between — a path with a space in
 * it stays one argument.
 *
 * What execFile does not do is tell "the command said no" apart from "the
 * command never ran": both arrive as the error in its callback. That distinction
 * is the whole contract of the port, so it is drawn here. An error that carries
 * an exit code is a normal result, with the output execFile captured alongside
 * it; a spawn failure or a kill is the rejection.
 */
import { execFile } from 'node:child_process';
import { headlessEnv } from '../../domain/launch/terminal-env';
import type { ExecOptions, ExecResult, ProcessRunner } from '../../application/ports/process-runner';

export interface NodeProcessRunnerDeps {
  /** The cleaned environment every child inherits — see `TerminalGateway.baseEnv`. */
  baseEnv: Record<string, string>;
}

/**
 * Far beyond any output a caller here should see. It is a safety net against
 * a runaway command, not a budget: hitting it kills the process and rejects,
 * because a truncated result would be silently wrong.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly deps: NodeProcessRunnerDeps) {}

  exec(file: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(file, [...args], {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        env: { ...headlessEnv(this.deps.baseEnv), ...opts.env },
      }, (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        if (err.killed || err.signal) {
          const why = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? `produced more than ${MAX_OUTPUT_BYTES} bytes of output`
            : `did not exit within ${opts.timeoutMs}ms and was killed with ${err.signal ?? 'a signal'}`;
          reject(new Error(`${file} ${why}`));
          return;
        }
        if (typeof err.code === 'number') {
          resolve({ stdout, stderr, code: err.code });
          return;
        }
        // No exit code and no signal: the process never ran (ENOENT, EACCES, …).
        reject(new Error(`${file} could not be started: ${err.message}`));
      });

      // Closed either way, so a child that reads stdin sees EOF rather than
      // waiting for input until the timeout kills it. The error handler is for
      // the child that exited — or never started — before the write landed;
      // without it an EPIPE on stdin would be an unhandled error.
      if (child.stdin) {
        child.stdin.on('error', () => {});
        if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
        else child.stdin.end();
      }
    });
  }
}
