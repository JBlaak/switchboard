/**
 * Running `claude` non-interactively, for scheduled tasks.
 *
 * A plain child process rather than a PTY: a scheduled run has no screen and no
 * user, so there is nothing to attach and nothing to render. It still goes
 * through the user's shell, because the command has to see the same PATH and
 * credentials an interactive session would. The shell `exec`s claude, so the
 * time limit's signal reaches claude itself rather than a shell waiting on it.
 *
 * stdout is kept, since `--output-format json` puts the run's report there,
 * and the end of stderr, because a run that fails says so there and there is
 * nobody watching.
 */
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {headlessEnv} from '../../domain/launch/terminal-env';
import {quoteArgvForShell, shellArgs} from '../../domain/shell/quoting';
import type {CommandEnding, CommandRunner, RunningCommand} from '../../application/ports/claude-cli';
import type {Logger} from '../../application/ports/logger';
import type {ShellProfileProvider} from '../../application/ports/shell-profiles';
import type {TerminalGateway} from '../../application/ports/terminal-gateway';
import {outputTail, STDERR_TAIL_CHARS, STDOUT_TAIL_CHARS} from './support/output-tail';

export interface ClaudeCommandRunnerDeps {
    shells: ShellProfileProvider;
    /** Only for its cleaned base environment — no PTY is involved. */
    terminals: TerminalGateway;
    log: Logger;
    shellProfileId(): string;
}

export class ClaudeCommandRunner implements CommandRunner {
    constructor(private readonly deps: ClaudeCommandRunnerDeps) {}

    public run(
        claudeArgs: readonly string[],
        cwd: string,
        name: string,
        onDone: (ending: CommandEnding) => void,
    ): RunningCommand {
        const {shells, terminals, log} = this.deps;
        const profile = shells.resolve(this.deps.shellProfileId());
        const command = 'exec claude ' + quoteArgvForShell(claudeArgs);
        const args = shellArgs(profile.path, command);

        log.info(`[schedule] running ${name} in ${cwd}`);

        const stdout = outputTail(STDOUT_TAIL_CHARS);
        const stderr = outputTail(STDERR_TAIL_CHARS);
        let finished = false;
        const done = (ending: Omit<CommandEnding, 'stdout' | 'stderr'>): void => {
            if (finished) return;
            finished = true;
            onDone({...ending, stdout: stdout.text(), stderr: stderr.text()});
        };

        let child: ChildProcess;
        try {
            child = spawn(profile.path, args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: headlessEnv(terminals.baseEnv),
            });
        } catch (err) {
            log.error(`[schedule] ${name} could not start:`, (err as Error).message);
            done({exitCode: null, signal: null, startError: (err as Error).message});
            return {kill: () => {}};
        }

        child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk));

        // 'close' comes after the streams are drained, so the output is whole.
        child.on('close', (code, signal) => {
            if (stderr.text().trim()) log.error(`[schedule] ${name} stderr:\n${stderr.text().trim()}`);
            log.info(`[schedule] ${name} finished (${signal ? `signal ${signal}` : `exit ${code}`})`);
            done({exitCode: code, signal, startError: null});
        });

        child.on('error', (err: Error) => {
            log.error(`[schedule] ${name} error:`, err.message);
            done({exitCode: null, signal: null, startError: err.message});
        });

        return {
            kill: (signal) => {
                try {
                    child.kill(signal);
                } catch {
                    // Already gone.
                }
            },
        };
    }
}
