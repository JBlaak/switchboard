/**
 * Turning an argv into a string a shell will take apart correctly.
 *
 * Every session is launched as `<shell> -c "<command>"`, and the command is
 * assembled from values the user typed — a worktree name, an extra directory, a
 * session id. Building that string by concatenation is how a directory with a
 * space in it becomes two arguments, so callers build an argv and quote it here.
 *
 * Every shell a Mac is likely to have takes POSIX single quotes, so the quoting
 * does not depend on which one the user picked.
 */

export function quoteArgvForShell(argv: readonly unknown[]): string {
  return argv.map(a => posixQuote(a == null ? '' : String(a))).join(' ');
}

/**
 * POSIX single-quoting: wrap in single quotes, escape embedded ones as '\''.
 *
 * Also for text that is going into a shell the user will run themselves — a
 * path pasted into a terminal, a command shown in the UI.
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
export function shellArgs(shellPath: string, cmd?: string | null): string[] {
  const base = shellPath.split('/').pop()?.toLowerCase() ?? '';
  const bashLike = base.includes('bash') || base.includes('zsh') || base === 'sh';
  const isFish = base === 'fish';
  const isNushell = base === 'nu';

  if (cmd) {
    if (bashLike) return ['-l', '-i', '-c', cmd];
    if (isFish || isNushell) return ['-l', '-c', cmd];
    return ['-c', cmd];
  }
  if (bashLike || isFish || isNushell) return ['-l', '-i'];
  return [];
}
