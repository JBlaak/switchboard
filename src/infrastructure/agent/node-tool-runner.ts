/**
 * Running git and gh for the Mac's pages, behind the tools part's ToolRunner
 * port (#276 stage 4, #296).
 *
 * `spawn`, never a shell, like the agent's other runners use `execFile`. It
 * differs from them in what a page needs:
 *
 * - stdout as raw bytes, never decoded (`git show HEAD:img.png` is a PNG),
 *   kept up to a cap and the rest read and dropped, so a big `git log` still
 *   answers with its real exit code and `truncated` instead of being killed
 *   the way `execFile`'s `maxBuffer` would.
 * - stdin, written and then closed; closed at once when there is none, so a
 *   tool that would read it sees end of file rather than waiting.
 * - only the tail of stderr, where git and gh put the reason.
 *
 * Each run gets its own process group (`detached`, which on Linux is a new
 * session with no controlling terminal: nothing can open `/dev/tty` to
 * prompt). A timeout or an abort kills that whole group with SIGKILL, so the
 * git that `gh` started, or the ssh that a `git fetch` started, goes too, and
 * answers at once with code -1 rather than waiting for pipes a straggler
 * still holds.
 *
 * `env` is the login-shell environment the agent computed at start (a systemd
 * user service's own PATH lacks `~/.local/bin`); each run adds its own
 * variables on top.
 */
import {spawn} from 'node:child_process';

import type {ToolRun, ToolRunner, ToolRunOptions} from '../../application/services/agent-host/tools';

export class NodeToolRunner implements ToolRunner {
    constructor(private readonly options: {env?: NodeJS.ProcessEnv} = {}) {}

    public run(command: string, args: readonly string[], options: ToolRunOptions): Promise<ToolRun> {
        return new Promise((resolve) => {
            const stdout: Buffer[] = [];
            let stdoutBytes = 0;
            let truncated = false;
            let stderr = Buffer.alloc(0);
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;

            const finish = (code: number, reason?: string) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
                const tail = stderr.toString('utf8');
                resolve({
                    code,
                    stdout: Buffer.concat(stdout),
                    truncated,
                    stderr: reason ? (tail ? `${tail}\n${reason}` : reason) : tail,
                });
            };

            if (options.signal?.aborted) return finish(-1, `${command}: aborted`);

            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(command, [...args], {
                    cwd: options.cwd,
                    env: {...(this.options.env ?? process.env), ...options.env},
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: true,
                    windowsHide: true,
                });
            } catch (error) {
                return finish(-1, `${command}: ${error instanceof Error ? error.message : String(error)}`);
            }

            const killGroup = () => {
                try {
                    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
                } catch {
                    // The group is gone already, or never formed: kill the child alone.
                    child.kill('SIGKILL');
                }
            };
            function onAbort(): void {
                killGroup();
                finish(-1, `${command}: aborted`);
            }
            options.signal?.addEventListener('abort', onAbort, {once: true});
            timer = setTimeout(() => {
                killGroup();
                finish(-1, `${command}: timed out after ${options.timeoutMs} ms`);
            }, options.timeoutMs);

            child.stdout?.on('data', (chunk: Buffer) => {
                const room = options.maxStdoutBytes - stdoutBytes;
                if (chunk.length > room) truncated = true;
                if (room <= 0) return;
                const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
                stdout.push(kept);
                stdoutBytes += kept.length;
            });
            child.stderr?.on('data', (chunk: Buffer) => {
                const joined = Buffer.concat([stderr, chunk]);
                stderr = joined.length > options.maxStderrBytes ? joined.subarray(-options.maxStderrBytes) : joined;
            });
            // A tool that exits without reading its stdin breaks the pipe: not an error of ours.
            child.stdin?.on('error', () => {});
            child.on('error', (error) => finish(-1, `${command}: ${error.message}`));
            child.on('close', (code) => finish(code ?? -1));

            if (options.stdin) child.stdin?.end(options.stdin);
            else child.stdin?.end();
        });
    }
}
