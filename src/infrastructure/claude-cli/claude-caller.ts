/**
 * Running one `claude -p` call and keeping what it prints, for Ask Patch.
 *
 * Through the user's shell, like a scheduled run, so the call sees the PATH
 * and the login an interactive session would. It runs in the home directory,
 * where no project's CLAUDE.md is picked up: the call is about choosing a
 * project, and the instructions of whichever one the app was launched from
 * have no say in that.
 *
 * The shell is started as the leader of its own process group, so an abort can
 * kill the group: killing only the shell would leave `claude` running on,
 * spending the user's quota on an answer nobody will read.
 */
import { spawn } from 'node:child_process';
import { headlessEnv } from '../../domain/launch/terminal-env';
import { quoteArgvForShell, shellArgs } from '../../domain/shell/quoting';
import type { ClaudeRun } from '../../domain/ask/route';
import type { ClaudeCaller } from '../../application/ports/claude-cli';
import type { Logger } from '../../application/ports/logger';
import type { ShellProfileProvider } from '../../application/ports/shell-profiles';
import type { TerminalGateway } from '../../application/ports/terminal-gateway';

export interface ShellClaudeCallerDeps {
  shells: ShellProfileProvider;
  /** Only for its cleaned base environment — no PTY is involved. */
  terminals: TerminalGateway;
  log: Logger;
  homeDir: string;
  shellProfileId(): string;
}

export class ShellClaudeCaller implements ClaudeCaller {
  constructor(private readonly deps: ShellClaudeCallerDeps) {}

  call(claudeArgs: readonly string[], signal: AbortSignal): Promise<ClaudeRun> {
    const { shells, terminals, log, homeDir } = this.deps;
    const profile = shells.resolve(this.deps.shellProfileId());
    const args = shellArgs(profile.path, 'claude ' + quoteArgvForShell(claudeArgs));

    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve({ exitCode: null, stdout: '', stderr: '' });
        return;
      }

      const child = spawn(profile.path, args, {
        cwd: homeDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: headlessEnv(terminals.baseEnv),
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const kill = (): void => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (err) {
          log.warn('[ask] could not stop the routing call:', (err as Error).message);
        }
      };
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
    });
  }
}
