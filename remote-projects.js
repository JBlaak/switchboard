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

// Seconds ssh may spend on the TCP handshake before giving up. Short on
// purpose: a sleeping host should fail into the reconnect loop quickly rather
// than sit on the OS default (~75s on macOS) with nothing on screen.
const CONNECT_TIMEOUT_SECONDS = 10;

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
  // ConnectTimeout: without it ssh blocks on the OS TCP timeout (~75s on
  // macOS) printing nothing at all, which is indistinguishable from a hung app.
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

// --- Reconnection ---
// An SSH link to a laptop-adjacent VM breaks constantly: the host sleeps, the
// network changes, the lid closes. The tmux session on the other end survives
// all of that, so a break is almost always worth papering over rather than
// surfacing as a dead terminal the user has to click again.

// Backoff for reconnect attempts, in ms. Bounded rather than infinite: a host
// that is really gone should stop costing an ssh process every 30s, and the
// user still has the session row to click when they want another go.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

function remoteRetryDelay(attempt) {
  const i = Math.max(1, Math.min(attempt, RETRY_DELAYS_MS.length)) - 1;
  return RETRY_DELAYS_MS[i];
}

// 255 is ssh's own "the connection failed or died" code. 0 means the user left
// the remote shell (or detached tmux) on purpose; 127 is our tmux-is-missing
// bail-out; anything else came from the remote command and is a real answer,
// not a transport problem.
//
// A signal is the other retryable case, and an easy one to miss: node-pty
// reports a signal-terminated child as exitCode 0, so an ssh that was *killed*
// is indistinguishable by code alone from one that exited cleanly. Switchboard's
// own kills (disconnect, quit, remove-remote) are filtered out before this by
// the userDisconnected flag, so a signal reaching here means the connection
// died in a way ssh never got to report.
function isRetryableSshExit(exitCode, signal) {
  if (signal) return true;
  return exitCode === 255;
}

// Failures ssh will reproduce exactly on the next attempt. Retrying these just
// spams the terminal with the same rejection, so a match cancels the backoff.
// Name resolution is deliberately absent: DNS is routinely unavailable for a
// few seconds after a wake, which is precisely when reconnecting should work.
const FATAL_SSH_OUTPUT = /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|tmux is not installed/i;

function isFatalSshOutput(text) {
  return FATAL_SSH_OUTPUT.test(String(text || ''));
}

// ssh's own transport complaints, written to stderr on its way out. They reach
// the PTY like any other output, so "the first byte arrived" is not by itself
// evidence that anything connected — a host wedged mid-handshake produces
// exactly one of these and nothing else.
//
// Distinguishing them matters for the connecting card: without it the card
// treats the error as a successful connect, disappears, and then reappears
// seconds later as "reconnecting", which is the flicker this avoids. Anything
// unmatched — a login banner, a password or host-key prompt, tmux repainting —
// counts as the far end talking, and the card steps aside so the terminal is
// usable.
const SSH_DIAGNOSTIC_OUTPUT = new RegExp([
  'Connection (?:to|closed|reset|refused)',
  'Connection timed out',
  'No route to host',
  'Host is down',
  'Operation timed out',
  'Could not resolve hostname',
  'banner exchange',
  'kex_exchange_identification',
  'Permission denied',
  'Host key verification failed',
  'REMOTE HOST IDENTIFICATION HAS CHANGED',
  '^ssh: ',
  '^ssh_exchange_identification',
].join('|'), 'im');

function isSshDiagnosticOutput(text) {
  return SSH_DIAGNOSTIC_OUTPUT.test(String(text || ''));
}

// Whether a chunk of PTY output is evidence that the far end is actually
// there — the single question the connecting card's "stop waiting" decision
// turns on. Empty and whitespace-only chunks prove nothing, ssh's own
// complaints prove the opposite, and everything else (prompt, banner, tmux
// repaint) means we got through and the terminal needs to be usable.
function outputProvesRemoteIsLive(data) {
  const t = String(data || '');
  if (!t.trim()) return false;
  return !isSshDiagnosticOutput(t);
}

// Human-readable reason for a dead ssh, for the status line in the terminal.
function describeSshExit(exitCode, signal) {
  if (signal) return `ssh was terminated (signal ${signal})`;
  if (exitCode === 0) return 'disconnected';
  if (exitCode === 255) return 'ssh connection failed or dropped';
  if (exitCode === 127) return 'tmux or ssh not found';
  return `exited with code ${exitCode}`;
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
  remoteRetryDelay,
  isRetryableSshExit,
  isFatalSshOutput,
  isSshDiagnosticOutput,
  outputProvesRemoteIsLive,
  describeSshExit,
  MAX_RETRIES,
  CONNECT_TIMEOUT_SECONDS,
};
