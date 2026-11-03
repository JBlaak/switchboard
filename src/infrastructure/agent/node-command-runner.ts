/**
 * Running the setup checks' commands on the VM, behind the CommandRunner port.
 *
 * No shell, no stdin (so `sudo -n` and `gh` can never sit waiting on a
 * prompt), output capped, and a hard kill on the timeout. A command that is not
 * installed, or that had to be killed, reports an exit code of null instead of
 * rejecting, which is what the checks above read as "not there".
 *
 * The agent runs as a systemd user service, whose PATH is short: tools a user
 * installs into `~/.local/bin` (Claude Code's installer does) are not on it.
 * `env` lets the agent pass the PATH its sessions get.
 */
import {execFile} from 'node:child_process';

import type {CommandResult, CommandRunner} from '../../application/services/agent-host/host-config';

/** A version line or `gh auth status` is a few hundred bytes; anything this big is not worth keeping. */
const MAX_OUTPUT_BYTES = 64 * 1024;

export class NodeCommandRunner implements CommandRunner {
    constructor(private readonly options: {env?: NodeJS.ProcessEnv} = {}) {}

    public run(command: string, args: string[], {timeoutMs}: {timeoutMs: number}): Promise<CommandResult> {
        return new Promise((resolve) => {
            const child = execFile(
                command,
                args,
                {
                    timeout: timeoutMs,
                    killSignal: 'SIGKILL',
                    maxBuffer: MAX_OUTPUT_BYTES,
                    encoding: 'utf8',
                    env: this.options.env ?? process.env,
                },
                (error, stdout, stderr) => {
                    if (!error) return resolve({exitCode: 0, stdout, stderr});
                    // A numeric code is the command's own exit status; anything else
                    // (ENOENT, a kill on the timeout, too much output) means no answer.
                    const code = (error as NodeJS.ErrnoException & {code?: unknown}).code;
                    const killed = (error as {killed?: boolean}).killed === true;
                    resolve({exitCode: typeof code === 'number' && !killed ? code : null, stdout, stderr});
                },
            );
            child.stdin?.end();
        });
    }
}
