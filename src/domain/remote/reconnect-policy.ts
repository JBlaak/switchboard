/**
 * When a dropped SSH connection is worth dialling again.
 *
 * An SSH link to a laptop-adjacent VM breaks constantly: the host sleeps, the
 * network changes, the lid closes. The tmux session on the other end survives
 * all of that, so a break is almost always worth papering over rather than
 * surfacing as a dead terminal the user has to click again. These are the rules
 * that decide which breaks are worth retrying, how long to wait, and what to
 * tell the user — the supervisor that acts on them lives in infrastructure.
 */

/**
 * Backoff for reconnect attempts, in ms.
 *
 * Bounded rather than infinite: a host that is really gone should stop costing
 * an ssh process every 30s, and the user still has the session row to click
 * when they want another go.
 */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export const MAX_RETRIES = RETRY_DELAYS_MS.length;

/**
 * How long a connection has to survive before it counts as "real".
 *
 * Without this, an ssh that connects far enough to print a rejection and then
 * dies would reset the backoff on every cycle and reconnect forever at 1s.
 */
export const REMOTE_STABLE_MS = 20000;

export function remoteRetryDelay(attempt: number): number {
  const i = Math.max(1, Math.min(attempt, RETRY_DELAYS_MS.length)) - 1;
  return RETRY_DELAYS_MS[i];
}

/**
 * Is this exit a transport failure rather than an answer?
 *
 * 255 is ssh's own "the connection failed or died" code. 0 means the user left
 * the remote shell (or detached tmux) on purpose; 127 is our tmux-is-missing
 * bail-out; anything else came from the remote command and is a real answer,
 * not a transport problem.
 *
 * A signal is the other retryable case, and an easy one to miss: node-pty
 * reports a signal-terminated child as exitCode 0, so an ssh that was *killed*
 * is indistinguishable by code alone from one that exited cleanly. Switchboard's
 * own kills (disconnect, quit, remove-remote) are filtered out before this by
 * the userDisconnected flag, so a signal reaching here means the connection
 * died in a way ssh never got to report.
 */
export function isRetryableSshExit(exitCode: number, signal?: number | string | null): boolean {
  if (signal) return true;
  return exitCode === 255;
}

/**
 * Failures ssh will reproduce exactly on the next attempt.
 *
 * Retrying these just spams the terminal with the same rejection, so a match
 * cancels the backoff. Name resolution is deliberately absent: DNS is routinely
 * unavailable for a few seconds after a wake, which is precisely when
 * reconnecting should work.
 */
const FATAL_SSH_OUTPUT = /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|tmux is not installed/i;

export function isFatalSshOutput(text: unknown): boolean {
  return FATAL_SSH_OUTPUT.test(String(text || ''));
}

/**
 * ssh's own transport complaints, written to stderr on its way out.
 *
 * They reach the PTY like any other output, so "the first byte arrived" is not
 * by itself evidence that anything connected — a host wedged mid-handshake
 * produces exactly one of these and nothing else.
 *
 * Distinguishing them matters for the connecting card: without it the card
 * treats the error as a successful connect, disappears, and then reappears
 * seconds later as "reconnecting", which is the flicker this avoids.
 */
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

export function isSshDiagnosticOutput(text: unknown): boolean {
  return SSH_DIAGNOSTIC_OUTPUT.test(String(text || ''));
}

/**
 * Whether a chunk of PTY output is evidence that the far end is actually
 * there — the single question the connecting card's "stop waiting" decision
 * turns on.
 *
 * Empty and whitespace-only chunks prove nothing, ssh's own complaints prove
 * the opposite, and everything else (prompt, banner, tmux repaint) means we got
 * through and the terminal needs to be usable.
 */
export function outputProvesRemoteIsLive(data: unknown): boolean {
  const t = String(data || '');
  if (!t.trim()) return false;
  return !isSshDiagnosticOutput(t);
}

/** Human-readable reason for a dead ssh, for the status line in the terminal. */
export function describeSshExit(exitCode: number, signal?: number | string | null): string {
  if (signal) return `ssh was terminated (signal ${signal})`;
  if (exitCode === 0) return 'disconnected';
  if (exitCode === 255) return 'ssh connection failed or dropped';
  if (exitCode === 127) return 'tmux or ssh not found';
  return `exited with code ${exitCode}`;
}
