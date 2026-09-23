/**
 * The ssh command that connects a session to its tmux session on a remote host.
 *
 * Each Switchboard session maps to one tmux session on the far end, which is
 * what lets the work continue after the SSH connection goes away and lets a
 * later connection attach to the same screen. The remote command creates that
 * tmux session detached on first open — so its pane is a login shell and
 * `claude` resolves from the user's real PATH — then attaches. On every later
 * open new-session fails silently and we attach to whatever is there: the
 * remote-desktop behaviour. Killing the local ssh only detaches; the tmux
 * session lives on.
 */
import { quoteArgvForShell, shellArgs } from '../shell/quoting';
import { isPowerShell } from '../shell/shell-profile';
import { expandRemoteDir, normalizeRemoteDir, tmuxSessionName } from '../project/remote-target';
import type { RemoteConfig } from '../project/remote-target';

/**
 * A stable path the tmux pane can export as SSH_AUTH_SOCK.
 *
 * `-A` forwards the local SSH agent so git on the remote acts as the user, but
 * forwarding gives each connection a fresh socket path which a long-lived tmux
 * session would outlive. So every connect refreshes a symlink at this fixed
 * location and the pane exports that instead. (While disconnected there is no
 * live socket: background work needing the agent waits for the next attach.)
 */
const AGENT_SOCK = '$HOME/.ssh/switchboard-agent.sock';

/**
 * Seconds ssh may spend on the TCP handshake before giving up.
 *
 * Short on purpose: a sleeping host should fail into the reconnect loop quickly
 * rather than sit on the OS default (~75s on macOS) with nothing on screen.
 */
export const CONNECT_TIMEOUT_SECONDS = 10;

/** How the PTY should invoke ssh. */
export interface SshSpawn {
  file: string;
  args: string[];
}

export interface SshSpawnOptions {
  shell?: string | null;
  shellExtraArgs?: readonly string[];
  /** Windows spawns ssh directly; see buildSshSpawn. */
  windows?: boolean;
}

/** The argv for ssh itself, ending in the command to run on the remote host. */
export function buildSshArgv(remote: RemoteConfig, sessionId: string, kind?: string): string[] {
  const name = tmuxSessionName(sessionId);
  const exportSock = `export SSH_AUTH_SOCK=${AGENT_SOCK}`;
  // send-keys types into the pane's login shell, so $HOME expands there.
  const bootstrap = kind === 'shell'
    ? ` && tmux send-keys -t ${name} '${exportSock}' Enter`
    : ` && tmux send-keys -t ${name} '${exportSock}; claude' Enter`;
  // Working directory: created if missing (mirrors how adding a local project
  // creates its folder) and set as the pane's start directory via tmux -c.
  const dir = normalizeRemoteDir(remote.dir);
  const dirSetup = dir ? `mkdir -p "${expandRemoteDir(dir)}" 2>/dev/null; ` : '';
  const dirArg = dir ? ` -c "${expandRemoteDir(dir)}"` : '';
  const remoteCmd =
    'command -v tmux >/dev/null 2>&1 || { echo "Switchboard: tmux is not installed on the remote host (e.g. apt install tmux)." >&2; exit 127; }; ' +
    `if [ -n "$SSH_AUTH_SOCK" ]; then mkdir -p $HOME/.ssh && ln -sf "$SSH_AUTH_SOCK" ${AGENT_SOCK}; fi; ` +
    dirSetup +
    `tmux new-session -d -s ${name}${dirArg} 2>/dev/null${bootstrap}; ` +
    `exec tmux attach-session -t ${name}`;

  // ConnectTimeout: without it ssh blocks on the OS TCP timeout printing
  // nothing at all, which is indistinguishable from a hung app.
  // ServerAliveCountMax is set explicitly so a dropped link is noticed in
  // ~45s regardless of what the user's ssh_config says.
  const argv = [
    '-t', '-A',
    '-o', 'ConnectTimeout=' + CONNECT_TIMEOUT_SECONDS,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (remote.port && Number(remote.port) !== 22) argv.push('-p', String(remote.port));
  argv.push(remote.user + '@' + remote.host, remoteCmd);
  return argv;
}

/**
 * How to hand that argv to the PTY.
 *
 * ssh runs inside the user's interactive login shell instead of being spawned
 * directly, because a GUI app inherits the desktop session's environment: on
 * macOS launchd sets SSH_AUTH_SOCK to Apple's ssh-agent, not the socket the
 * user's shell profile exports for 1Password (or gpg-agent, keychain, …). Keys
 * that live only in the real agent are then invisible and every connection
 * fails "Permission denied (publickey)" — even though the same ssh works in a
 * terminal. Sourcing the profile also gets the PATH and ssh config wrappers the
 * user actually uses. `exec` replaces the shell with ssh, so the PTY still
 * drives ssh itself and closing the session detaches from tmux exactly as
 * before.
 *
 * Windows spawns ssh directly: ssh.exe reaches its agent over a named pipe, so
 * there is nothing to inherit, and cmd/PowerShell have no exec.
 */
export function buildSshSpawn(
  sshArgv: string[],
  { shell, shellExtraArgs = [], windows = false }: SshSpawnOptions = {},
): SshSpawn {
  if (windows || !shell) return { file: 'ssh', args: sshArgv };
  const exec = isPowerShell(shell) ? '' : 'exec ';
  const cmd = exec + 'ssh ' + quoteArgvForShell(shell, sshArgv);
  return { file: shell, args: shellArgs(shell, cmd, shellExtraArgs) };
}
