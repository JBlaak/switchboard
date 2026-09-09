/**
 * Turning an argv into a string one particular shell will take apart correctly.
 *
 * Every session is launched as `<shell> -c "<command>"`, and the command is
 * assembled from values the user typed — a worktree name, an extra directory, a
 * session id. Building that string by concatenation is how a directory with a
 * space in it becomes two arguments, so callers build an argv and quote it here.
 */
import { isWslShell, isPowerShell, quotesPosixStyle } from './shell-profile';

/** Quote one argv token for the given shell. */
export function quoteArgForShell(shellPath: string, value: unknown): string {
  const s = value == null ? '' : String(value);

  if (quotesPosixStyle(shellPath)) {
    // POSIX: wrap in single quotes, escape embedded single quotes as '\''
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  if (isPowerShell(shellPath)) {
    // PowerShell: single-quoted string, escape ' as ''
    return "'" + s.replace(/'/g, "''") + "'";
  }
  // cmd.exe: double-quote, escape " as \" and ^-escape shell metachars
  const escaped = s.replace(/"/g, '\\"').replace(/([&|<>^%])/g, '^$1');
  return '"' + escaped + '"';
}

export function quoteArgvForShell(shellPath: string, argv: readonly unknown[]): string {
  return argv.map(a => quoteArgForShell(shellPath, a)).join(' ');
}

/**
 * POSIX single-quoting, for text that is going into a shell the user will run
 * themselves — a path pasted into a terminal, a command shown in the UI.
 */
export function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * The spawn arguments that make a shell run `cmd`, or start interactively when
 * no command is given.
 *
 * Login+interactive (`-l -i`) rather than a bare `-c`, because a session has to
 * see the PATH, the version managers and the ssh-agent the user's own terminal
 * sees — a GUI app inherits none of that from the desktop session.
 */
export function shellArgs(
  shellPath: string,
  cmd?: string | null,
  extraArgs?: readonly string[] | null,
): string[] {
  const base = shellPath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const bashLike = base.includes('bash') || base.includes('zsh') || base === 'sh';
  const isFish = base === 'fish';
  const isNushell = base === 'nu';

  // WSL: the command goes to the distribution's shell after `--`.
  // The working directory is handled separately, via --cd in the spawn call.
  if (isWslShell(shellPath)) {
    const prefix = [...(extraArgs || []), '--', 'bash', '-l', '-i'];
    return cmd ? [...prefix, '-c', cmd] : prefix;
  }

  if (cmd) {
    if (bashLike) return ['-l', '-i', '-c', cmd];
    if (isFish || isNushell) return ['-l', '-c', cmd];
    if (isPowerShell(shellPath)) return ['-NoLogo', '-Command', cmd];
    return ['/C', cmd];
  }
  if (bashLike || isFish || isNushell) return ['-l', '-i'];
  if (isPowerShell(shellPath)) return ['-NoLogo', '-NoExit'];
  return [];
}
