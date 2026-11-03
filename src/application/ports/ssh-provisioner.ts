/**
 * Running commands and copying files on a host over ssh, before there is an
 * agent to ask (#276).
 *
 * This is what installs, checks and upgrades the agent. It goes through the
 * user's own ssh the same way remote sessions do (their login shell, keys and
 * `~/.ssh/config`), with no TTY.
 */
import type {RemoteConfig} from '../../domain/project/remote-target';

export interface RemoteRun {
    code: number;
    stdout: string;
    stderr: string;
}

export interface SshProvisioner {
    /**
     * Run `command` in the host's login shell and wait for it to end.
     *
     * Rejects only when ssh itself could not connect; a command that fails
     * resolves with its non-zero code.
     */
    run(
        host: RemoteConfig,
        command: string,
        options?: {stdin?: string | Buffer; timeoutMs?: number},
    ): Promise<RemoteRun>;

    /** Copy one local file to `remotePath` (may start with `$HOME`), creating its folder. */
    upload(host: RemoteConfig, localPath: string, remotePath: string, mode?: number): Promise<void>;
}
