/**
 * Running `claude` non-interactively, for scheduled tasks.
 *
 * A plain child process rather than a PTY: a scheduled run has no screen and no
 * user, so there is nothing to attach and nothing to render. It still goes
 * through the user's shell, because the command has to see the same PATH and
 * credentials an interactive session would.
 *
 * stdout is discarded — the run's real output is the transcript it writes —
 * while stderr is captured, because a run that fails says so there and there is
 * nobody watching.
 */
import { spawn } from 'node:child_process';
import { headlessEnv } from '../../domain/launch/terminal-env';
import { quoteArgvForShell, shellArgs } from '../../domain/shell/quoting';
import type { CommandRunner } from '../../application/ports/claude-cli';
import type { Logger } from '../../application/ports/logger';
import type { ShellProfileProvider } from '../../application/ports/shell-profiles';
import type { TerminalGateway } from '../../application/ports/terminal-gateway';

export interface ClaudeCommandRunnerDeps {
  shells: ShellProfileProvider;
  /** Only for its cleaned base environment — no PTY is involved. */
  terminals: TerminalGateway;
  log: Logger;
  shellProfileId(): string;
}

export class ClaudeCommandRunner implements CommandRunner {
  constructor(private readonly deps: ClaudeCommandRunnerDeps) {}

  run(claudeArgs: readonly string[], cwd: string, name: string, onDone: () => void): void {
    const { shells, terminals, log } = this.deps;
    const profile = shells.resolve(this.deps.shellProfileId());
    const command = 'claude ' + quoteArgvForShell(profile.path, claudeArgs);
    const args = shellArgs(profile.path, command, profile.args);

    log.info(`[schedule] running: ${profile.path} ${args.join(' ')}`);

    const child = spawn(profile.path, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: headlessEnv(terminals.baseEnv),
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('exit', (code) => {
      if (stderr.trim()) log.error(`[schedule] ${name} stderr:\n${stderr.trim()}`);
      log.info(`[schedule] ${name} finished (exit ${code})`);
      onDone();
    });

    child.on('error', (err: Error) => {
      log.error(`[schedule] ${name} error:`, err.message);
      onDone();
    });
  }
}
