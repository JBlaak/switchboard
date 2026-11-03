/**
 * `SshProvisioner` over the user's own `ssh` binary (#276).
 *
 * The argv and the remote command lines are built in
 * `domain/agent/ssh-provision.ts`; this file only spawns ssh, feeds it stdin
 * and collects what it prints.
 *
 * ssh is spawned directly, with the PATH and SSH_AUTH_SOCK of the user's login
 * shell (`loginShellEnv`, the same environment `gh` and `git fetch` get),
 * rather than as `<shell> -l -i -c 'exec ssh …'` the way a session's PTY does.
 * The login shell matters for the same reason as there: a GUI app inherits
 * launchd's SSH_AUTH_SOCK, not the 1Password (or gpg) agent the user's profile
 * points at, so without it every key in that agent is invisible. Reading that
 * environment once and spawning ssh with it gets the same keys and ssh config,
 * and keeps stdout clean: an interactive shell's banner or `echo` in a zshrc
 * would otherwise land in front of the host check's answers.
 */
import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import type {Readable} from 'node:stream';
import type {RemoteConfig} from '../../domain/project/remote-target';
import {
    PROVISION_DEFAULT_TIMEOUT_MS,
    buildProvisionSshArgv,
    isSshConnectFailure,
    sshFailureMessage,
    writeStdinToFileScript,
} from '../../domain/agent/ssh-provision';
import type {RemoteRun, SshProvisioner} from '../../application/ports/ssh-provisioner';
import type {Logger} from '../../application/ports/logger';

/** Thrown when ssh itself could not reach the host; carries ssh's own message. */
export class SshConnectError extends Error {
    public readonly stderr: string;

    constructor(host: RemoteConfig, stderr: string) {
        super(`Could not connect to ${host.user}@${host.host}: ${sshFailureMessage(stderr)}`);
        this.name = 'SshConnectError';
        this.stderr = stderr;
    }
}

/** Thrown when a command outlived its timeout and was killed. */
export class SshTimeoutError extends Error {
    constructor(host: RemoteConfig, timeoutMs: number) {
        super(`${host.user}@${host.host} did not answer within ${Math.round(timeoutMs / 1000)} s.`);
        this.name = 'SshTimeoutError';
    }
}

/** The longest an upload may take: a few MB over a slow link. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * How much of a command's output is kept. The installer's scripts print a few
 * lines; this only stops a runaway command from filling memory.
 */
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class OpenSshProvisioner implements SshProvisioner {
    /**
     * @param env The environment ssh runs in, normally `loginShellEnv(...)`.
     * @param sshPath The ssh binary; `ssh` is found on that environment's PATH.
     */
    constructor(
        private readonly env: () => Promise<Record<string, string>>,
        private readonly log: Logger,
        private readonly sshPath = 'ssh',
    ) {}

    public async run(
        host: RemoteConfig,
        command: string,
        options: {stdin?: string | Buffer; timeoutMs?: number} = {},
    ): Promise<RemoteRun> {
        const result = await this.spawnSsh(
            host,
            command,
            options.stdin,
            options.timeoutMs ?? PROVISION_DEFAULT_TIMEOUT_MS,
        );
        if (isSshConnectFailure(result.code, result.stderr)) throw new SshConnectError(host, result.stderr);
        return result;
    }

    public async upload(host: RemoteConfig, localPath: string, remotePath: string, mode = 0o644): Promise<void> {
        const result = await this.spawnSsh(
            host,
            writeStdinToFileScript(remotePath, mode),
            createReadStream(localPath),
            UPLOAD_TIMEOUT_MS,
        );
        if (isSshConnectFailure(result.code, result.stderr)) throw new SshConnectError(host, result.stderr);
        if (result.code !== 0) {
            throw new Error(`Uploading to ${remotePath} failed (exit ${result.code}): ${lastLine(result.stderr)}`);
        }
    }

    private async spawnSsh(
        host: RemoteConfig,
        script: string,
        stdin: string | Buffer | Readable | undefined,
        timeoutMs: number,
    ): Promise<RemoteRun> {
        const env = await this.env();
        const argv = buildProvisionSshArgv(host, script);
        return new Promise<RemoteRun>((resolve, reject) => {
            const child = spawn(this.sshPath, argv, {env, stdio: ['pipe', 'pipe', 'pipe']});
            const stdout = new OutputBuffer();
            const stderr = new OutputBuffer();
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGTERM');
            }, timeoutMs);

            child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
            // A script that doesn't read its stdin closes the pipe; that is not a failure of the run.
            child.stdin.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code !== 'EPIPE') this.log.warn('[provision] ssh stdin:', err.message);
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                reject(new Error(`Could not start ssh: ${err.message}`));
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                if (timedOut) return reject(new SshTimeoutError(host, timeoutMs));
                resolve({code: code ?? (signal ? 128 : 1), stdout: stdout.text(), stderr: stderr.text()});
            });

            if (stdin === undefined) child.stdin.end();
            else if (typeof stdin === 'string' || Buffer.isBuffer(stdin)) child.stdin.end(stdin);
            else {
                stdin.on('error', (err) => {
                    this.log.warn('[provision] reading the upload failed:', err.message);
                    child.kill('SIGTERM');
                });
                stdin.pipe(child.stdin);
            }
        });
    }
}

/** Collects a stream's output up to `MAX_OUTPUT_BYTES`. */
class OutputBuffer {
    private readonly chunks: Buffer[] = [];
    private size = 0;

    public push(chunk: Buffer): void {
        if (this.size >= MAX_OUTPUT_BYTES) return;
        this.chunks.push(chunk);
        this.size += chunk.length;
    }

    public text(): string {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}

function lastLine(text: string): string {
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    return lines[lines.length - 1] ?? 'no message';
}
