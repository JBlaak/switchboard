// Remote (SSH) projects — identity, validation, and connection command building.
//
// A remote project is identified by an ssh:// pseudo-path ("ssh://user@host" or
// "ssh://user@host:2222") so it can flow through every code path that treats
// projectPath as an opaque string (sidebar ids, settings keys, session maps).
// Each Switchboard session maps to one tmux session on the remote host, which
// is what lets the work continue after the SSH connection goes away and lets a
// later connection attach to the same screen.

const path = require('path');
const { isWindows, shellArgs, quoteArgvForShell } = require('./shell-profiles');

function isRemoteProjectPath(projectPath) {
  return typeof projectPath === 'string' && projectPath.startsWith('ssh://');
}

// The working directory is optional; "~" and "" both mean the login home, so
// they normalize to null and stay out of the identity string.
function normalizeRemoteDir(dir) {
  const d = typeof dir === 'string' ? dir.trim().replace(/\/+$/, '') : '';
  return d && d !== '~' ? d : null;
}

function remoteProjectPath({ user, host, port, dir }) {
  const p = Number(port) || 22;
  const base = 'ssh://' + user + '@' + host + (p === 22 ? '' : ':' + p);
  const d = normalizeRemoteDir(dir);
  return d ? base + '/' + d : base;
}

function parseRemoteProjectPath(projectPath) {
  const m = /^ssh:\/\/([^@]+)@([^:@/]+)(?::(\d+))?(?:\/(.+))?$/.exec(projectPath || '');
  if (!m) return null;
  return { user: m[1], host: m[2], port: m[3] ? Number(m[3]) : 22, dir: m[4] || null };
}

// user/host/dir end up inside an ssh argv and a remote shell command line;
// restricting the alphabet up front is simpler than quoting for both layers.
function validateRemoteInput({ user, host, port, dir } = {}) {
  if (!user || !/^[a-zA-Z0-9._-]+$/.test(user)) return 'Username may only contain letters, digits, ".", "_" and "-".';
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) return 'Host must be a hostname or IPv4 address.';
  const p = (port === undefined || port === null || port === '') ? 22 : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be a number between 1 and 65535.';
  const d = normalizeRemoteDir(dir);
  if (d && !/^[a-zA-Z0-9._~/ -]+$/.test(d)) return 'Directory may only contain letters, digits, spaces and ./_~- characters.';
  return null;
}

// The directory goes inside double quotes in the remote command, so ~ has to
// become $HOME by hand; bare relative paths are anchored to $HOME too, since
// that is what a path typed next to "user@host" naturally means.
function expandRemoteDir(dir) {
  if (dir.startsWith('/')) return dir;
  const rest = dir.startsWith('~/') ? dir.slice(2) : dir;
  return rest ? '$HOME/' + rest : '$HOME';
}

function tmuxSessionName(sessionId) {
  return 'sb-' + String(sessionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

// argv for ssh (handed to the PTY by buildSshSpawn below). The remote command
// creates the tmux session detached on first open — so its pane is a login
// shell and `claude` resolves from the user's real PATH — then attaches. On
// every later open new-session fails silently and we attach to whatever is
// there: the remote-desktop behavior. Killing the local ssh only detaches;
// the tmux session lives on.
//
// -A forwards the local SSH agent so git on the remote acts as the user.
// Forwarding gives each connection a fresh socket path, which a long-lived
// tmux session would outlive — so every connect refreshes a stable symlink to
// the live socket and the tmux pane exports that symlink as SSH_AUTH_SOCK.
// (While disconnected there is no live socket: background work that needs the
// agent has to wait for the next attach.)
const AGENT_SOCK = '$HOME/.ssh/switchboard-agent.sock';

function buildSshArgv(remote, sessionId, kind) {
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
  const argv = ['-t', '-A', '-o', 'ServerAliveInterval=15'];
  if (remote.port && Number(remote.port) !== 22) argv.push('-p', String(remote.port));
  argv.push(remote.user + '@' + remote.host, remoteCmd);
  return argv;
}

// How to hand that argv to the PTY. ssh runs inside the user's interactive
// login shell instead of being spawned directly, because a GUI app inherits
// the desktop session's environment: on macOS launchd sets SSH_AUTH_SOCK to
// Apple's ssh-agent, not the socket the user's shell profile exports for
// 1Password (or gpg-agent, keychain, …). Keys that live only in the real agent
// are then invisible and every connection fails "Permission denied
// (publickey)" — even though the same ssh works in a terminal. Sourcing the
// profile also gets the PATH and ssh config wrappers the user actually uses.
// `exec` replaces the shell with ssh, so the PTY still drives ssh itself and
// closing the session detaches from tmux exactly as before.
// Windows spawns ssh directly: ssh.exe reaches its agent over a named pipe, so
// there is nothing to inherit, and cmd/PowerShell have no exec.
function buildSshSpawn(sshArgv, { shell, shellExtraArgs = [], windows = isWindows } = {}) {
  if (windows || !shell) return { file: 'ssh', args: sshArgv };
  const base = path.basename(shell).toLowerCase();
  const exec = (base.includes('powershell') || base.includes('pwsh')) ? '' : 'exec ';
  const cmd = exec + 'ssh ' + quoteArgvForShell(shell, sshArgv);
  return { file: shell, args: shellArgs(shell, cmd, shellExtraArgs) };
}

module.exports = {
  isRemoteProjectPath,
  remoteProjectPath,
  parseRemoteProjectPath,
  normalizeRemoteDir,
  validateRemoteInput,
  tmuxSessionName,
  buildSshArgv,
  buildSshSpawn,
};
