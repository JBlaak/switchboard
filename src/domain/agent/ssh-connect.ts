/**
 * The ssh command that carries the Mac's link to a VM's agent (#276).
 *
 * Unlike a legacy remote session, which is one interactive ssh per session
 * attached to tmux, an agent host has one ssh per host and it carries bytes,
 * not a terminal: the remote command is `switchboard-agent connect`, which
 * bridges its stdio to the agent's Unix socket, and the frames of
 * `framing.ts` travel over ssh's stdin and stdout. So:
 *
 * - `-T`: no PTY. A PTY would translate line endings and eat control bytes,
 *   which corrupts binary frames.
 * - `-e none`: no escape character, so a `~.` inside a frame is just bytes.
 * - no `-A`: the agent never gets the Mac's ssh agent. Its sessions use the
 *   VM's own credentials (#276: Mac credentials never reach the VM).
 * - the same ConnectTimeout and keep-alives as `buildSshArgv`, for the same
 *   reasons: a sleeping host fails fast into the reconnect ladder, and a dead
 *   link is noticed in about 45 seconds whatever the user's ssh_config says.
 *
 * Pure: the dialer in infrastructure spawns what this builds.
 */
import {quoteArgvForShell, shellArgs} from '../shell/quoting';
import {CONNECT_TIMEOUT_SECONDS} from '../remote/ssh-command';
import {AGENT_CONNECT_COMMAND} from './layout';
import type {RemoteConfig} from '../project/remote-target';
import type {SshSpawn} from '../remote/ssh-command';

/**
 * What the login shell prints just before it `exec`s ssh.
 *
 * The link has to go through the user's login shell (see `buildAgentSshSpawn`),
 * and an interactive shell's rc files may print to stdout: a banner, a
 * `fortune`, a version manager's notice. Those bytes would land in front of
 * the first frame and wreck the framing, so the dialer throws away everything
 * up to and including this marker. Nothing an rc file prints is likely to
 * contain it.
 */
export const AGENT_STREAM_SENTINEL = '__SWITCHBOARD_AGENT_STREAM__\n';

/** The argv for ssh itself, ending in the connect command to run on the host. */
export function buildAgentSshArgv(remote: RemoteConfig): string[] {
    const argv = [
        '-T',
        '-e',
        'none',
        '-o',
        'ConnectTimeout=' + CONNECT_TIMEOUT_SECONDS,
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
    ];
    if (remote.port && Number(remote.port) !== 22) argv.push('-p', String(remote.port));
    // `$HOME` in the connect command expands in the remote shell ssh starts it
    // in; quoting on the Mac keeps it literal until then.
    argv.push(remote.user + '@' + remote.host, AGENT_CONNECT_COMMAND);
    return argv;
}

/** How to start the link's ssh, and whether its stdout starts with the sentinel. */
export interface AgentSshSpawn extends SshSpawn {
    /** True when stdout is preceded by whatever the shell printed, then `AGENT_STREAM_SENTINEL`. */
    sentinel: boolean;
}

/**
 * Run ssh inside the user's login shell, as `buildSshSpawn` does and for the
 * same reason: a GUI app inherits launchd's SSH_AUTH_SOCK (Apple's agent), not
 * the one the user's profile exports (1Password, gpg-agent), and keys that
 * live only in the real agent would be invisible. The shell prints the
 * sentinel once its rc files have run, then becomes ssh.
 *
 * Without a shell ssh is spawned directly and there is nothing to skip.
 */
export function buildAgentSshSpawn(remote: RemoteConfig, shell?: string | null): AgentSshSpawn {
    const argv = buildAgentSshArgv(remote);
    if (!shell) return {file: 'ssh', args: argv, sentinel: false};
    const cmd = `printf '%s\\n' '${AGENT_STREAM_SENTINEL.trimEnd()}'; exec ssh ${quoteArgvForShell(argv)}`;
    return {file: shell, args: shellArgs(shell, cmd), sentinel: true};
}

/**
 * Drops a stream's bytes up to and including the sentinel, then passes the
 * rest through untouched.
 *
 * Only the last few bytes are held while looking, so a chatty rc file costs
 * no memory, and a sentinel split across chunks is still found.
 */
export class SentinelGate {
    private open: boolean;
    private held: Buffer = Buffer.alloc(0);
    private readonly marker = Buffer.from(AGENT_STREAM_SENTINEL, 'utf8');

    constructor(enabled: boolean) {
        this.open = !enabled;
    }

    /** The bytes of `chunk` that belong to the link; empty while still looking. */
    public push(chunk: Buffer): Buffer {
        if (this.open) return chunk;
        const joined = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
        const at = joined.indexOf(this.marker);
        if (at === -1) {
            this.held = joined.subarray(Math.max(0, joined.length - (this.marker.length - 1)));
            return Buffer.alloc(0);
        }
        this.open = true;
        this.held = Buffer.alloc(0);
        return joined.subarray(at + this.marker.length);
    }
}
