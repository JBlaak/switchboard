/**
 * Running git and gh for the project copies, behind the CopyCommandRunner port.
 *
 * As NodeCommandRunner does for the setup checks: no shell, no stdin (so a
 * credential or host-key prompt fails at once instead of hanging a hand-off
 * the Mac is waiting on), a hard kill on the timeout, and an exit code of null
 * for a command that is not installed or had to be killed. It differs in what
 * a copy needs: a working folder, extra variables per call on top of the
 * login-shell environment the agent computed, and room for the output of
 * `git status` on a big tree.
 */
import {execFile} from 'node:child_process';

import type {CopyCommandRunner} from '../../application/services/agent-host/copies';
import type {CommandResult} from '../../application/services/agent-host/host-config';

/** `git status -z` on a tree with many untracked files can be large; past this it is not worth reading. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export class NodeCopyCommandRunner implements CopyCommandRunner {
    constructor(private readonly options: {env?: NodeJS.ProcessEnv} = {}) {}

    public run(
        command: string,
        args: string[],
        {cwd, env, timeoutMs}: {cwd?: string; env?: Record<string, string>; timeoutMs: number},
    ): Promise<CommandResult> {
        return new Promise((resolve) => {
            const child = execFile(
                command,
                args,
                {
                    cwd,
                    timeout: timeoutMs,
                    killSignal: 'SIGKILL',
                    maxBuffer: MAX_OUTPUT_BYTES,
                    encoding: 'utf8',
                    env: {...(this.options.env ?? process.env), ...env},
                },
                (error, stdout, stderr) => {
                    if (!error) return resolve({exitCode: 0, stdout, stderr});
                    // A numeric code is the command's own exit status; anything else
                    // (ENOENT, a missing cwd, a kill on the timeout, too much output)
                    // means no answer.
                    const code = (error as NodeJS.ErrnoException & {code?: unknown}).code;
                    const killed = (error as {killed?: boolean}).killed === true;
                    const reason = typeof code === 'number' ? '' : `${command}: ${error.message}`;
                    resolve({
                        exitCode: typeof code === 'number' && !killed ? code : null,
                        stdout,
                        stderr: stderr || reason,
                    });
                },
            );
            child.stdin?.end();
        });
    }
}
