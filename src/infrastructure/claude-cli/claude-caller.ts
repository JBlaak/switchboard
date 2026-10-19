/**
 * Running `claude -p` and keeping what it prints, for Ask Patch.
 *
 * `claude` is started directly, with the PATH the user's login shell has: the
 * shell is asked for it once and the answer kept (S3), rather than starting
 * `zsh -l -i` on every call, which cost about 0.45 s each time. It is asked
 * again when the shell profile setting points at another shell. The call runs
 * in the home directory, where no project's CLAUDE.md is picked up: the call
 * is about choosing a project, and the instructions of whichever one the app
 * was launched from have no say in that.
 *
 * Every process is started as the leader of its own process group, so an
 * abort can kill the group: killing only `claude` could leave what it started
 * running on, spending the user's quota on an answer nobody will read.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { headlessEnv } from '../../domain/launch/terminal-env';
import { loginShellEnv } from '../shell/login-shell-env';
import { endedRun, finishedRun, streamJsonArgs, userMessageLine } from './stream-json';
import type { ClaudeRun } from '../../domain/ask/route';
import { WARM_IDLE_MS } from '../../application/ports/claude-cli';
import type { ClaudeCaller, WarmCall } from '../../application/ports/claude-cli';
import type { Timers } from '../../application/ports/clock';
import type { Logger } from '../../application/ports/logger';
import type { ShellProfileProvider } from '../../application/ports/shell-profiles';
import type { TerminalGateway } from '../../application/ports/terminal-gateway';

/** How long a warm process that has answered gets to exit on its own once stdin closes. */
const EXIT_GRACE_MS = 2_000;

export interface ShellClaudeCallerDeps {
  shells: ShellProfileProvider;
  /** Only for its cleaned base environment — no PTY is involved. */
  terminals: TerminalGateway;
  timers: Timers;
  log: Logger;
  homeDir: string;
  shellProfileId(): string;
}

/** One warm process, from the caller's side. */
interface WarmProcess {
  readonly alive: boolean;
  send(prompt: string, signal: AbortSignal): Promise<ClaudeRun>;
  kill(): void;
}

export class ShellClaudeCaller implements ClaudeCaller {
  #env: { shell: string; read: () => Promise<Record<string, string>> } | null = null;
  readonly #warm = new Set<WarmProcess>();

  constructor(private readonly deps: ShellClaudeCallerDeps) {}

  call(claudeArgs: readonly string[], signal: AbortSignal): Promise<ClaudeRun> {
    const { log } = this.deps;
    return this.#environment().then(env => new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve({ exitCode: null, stdout: '', stderr: '' });
        return;
      }

      const child = this.#spawn(claudeArgs, env, 'ignore');
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const kill = (): void => this.#kill(child);
      signal.addEventListener('abort', kill, { once: true });

      child.on('close', (code) => {
        signal.removeEventListener('abort', kill);
        resolve({ exitCode: code, stdout, stderr });
      });
      child.on('error', (err: Error) => {
        signal.removeEventListener('abort', kill);
        log.error('[ask] could not run claude:', err.message);
        reject(err);
      });
    }));
  }

  /**
   * A process booted now, for one `send` later. A send that finds it gone —
   * killed for idling, or crashed — starts another, so it still answers.
   */
  warm(bootArgs: readonly string[]): WarmCall {
    let ready: WarmProcess | null = this.#startWarm(bootArgs);
    return {
      send: (prompt, signal) => {
        const next = ready?.alive ? ready : this.#startWarm(bootArgs);
        ready = null;
        return next.send(prompt, signal);
      },
    };
  }

  /** Kill every warm process, for quitting. */
  close(): void {
    for (const warm of [...this.#warm]) warm.kill();
  }

  #startWarm(bootArgs: readonly string[]): WarmProcess {
    const { timers, log } = this.deps;
    let child: ChildProcess | null = null;
    let ended = false;
    let failure: Error | null = null;
    let stdout = '';
    let stderr = '';
    let answer: { resolve(run: ClaudeRun): void; reject(err: Error): void } | null = null;
    let exitTimer: unknown = null;

    const kill = (): void => {
      if (child) this.#kill(child);
      else end();
    };
    const end = (): void => {
      if (ended) return;
      ended = true;
      timers.clearTimeout(idleTimer);
      timers.clearTimeout(exitTimer);
      this.#warm.delete(warm);
    };
    const settle = (run: ClaudeRun): void => {
      answer?.resolve(run);
      answer = null;
    };
    const idleTimer = timers.setTimeout(() => {
      log.info('[ask] killing a warm claude nobody used');
      kill();
    }, WARM_IDLE_MS);

    const started = this.#environment().then((env) => {
      if (ended) return;
      child = this.#spawn(streamJsonArgs(bootArgs), env, 'pipe');
      // A process killed before it reads stdin makes writing to it fail; the
      // close below is what reports that.
      child.stdin!.on('error', () => {});
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (!answer) return;
        const run = finishedRun(stdout, stderr);
        if (!run) return;
        settle(run);
        // One request per process: closing stdin lets it exit on its own.
        child?.stdin?.end();
        exitTimer = timers.setTimeout(kill, EXIT_GRACE_MS);
      });
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => {
        end();
        settle(endedRun(stdout, code, stderr));
      });
      child.on('error', (err: Error) => {
        log.error('[ask] could not run claude:', err.message);
        failure = err;
        end();
        answer?.reject(err);
        answer = null;
      });
    });

    const warm: WarmProcess = {
      get alive() { return !ended; },
      kill,
      send: (prompt, signal) => {
        timers.clearTimeout(idleTimer);
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            kill();
            resolve({ exitCode: null, stdout: '', stderr: '' });
            return;
          }
          answer = {
            resolve: (run) => { signal.removeEventListener('abort', kill); resolve(run); },
            reject: (err) => { signal.removeEventListener('abort', kill); reject(err); },
          };
          signal.addEventListener('abort', kill, { once: true });
          void started.then(() => {
            if (failure) answer?.reject(failure);
            else if (ended) settle(endedRun(stdout, null, stderr));
            else child?.stdin?.write(userMessageLine(prompt));
          });
        });
      },
    };
    this.#warm.add(warm);
    return warm;
  }

  /** The login shell's environment, read once per shell, ready for a headless run. */
  #environment(): Promise<Record<string, string>> {
    const { shells, terminals, log } = this.deps;
    const shell = shells.resolve(this.deps.shellProfileId()).path;
    if (this.#env?.shell !== shell) this.#env = { shell, read: loginShellEnv(() => shell, terminals.baseEnv, log) };
    return this.#env.read().then(headlessEnv);
  }

  #spawn(args: readonly string[], env: Record<string, string>, stdin: 'ignore' | 'pipe'): ChildProcess {
    // `claude` is looked up on `env.PATH`, the login shell's.
    return spawn('claude', args, {
      cwd: this.deps.homeDir,
      stdio: [stdin, 'pipe', 'pipe'],
      env,
      detached: true,
    });
  }

  #kill(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (err) {
      this.deps.log.warn('[ask] could not stop claude:', (err as Error).message);
    }
  }
}
