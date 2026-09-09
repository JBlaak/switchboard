/**
 * Shell families, and the differences between them that matter here.
 *
 * Switchboard launches every session by handing a command string to the user's
 * own shell, so it has to know how each one takes a command, how each one
 * quotes an argument, and which of them is really a Linux distribution behind a
 * Windows launcher. Those three questions are all answered from the shell's
 * path, which is why they live together.
 */

/** A shell the user can launch a session in. */
export interface ShellProfile {
  id: string;
  name: string;
  /** Absolute path, or 'wsl.exe' which is resolved off PATH. */
  path: string;
  args?: string[];
}

/**
 * The filename part of a path, without reaching for `node:path`.
 *
 * Splits on both separators so a Windows path works under a POSIX runtime and
 * vice versa — this module is shared with the renderer, which has neither.
 */
export function shellBaseName(shellPath: string): string {
  const parts = shellPath.split(/[\\/]/);
  return (parts[parts.length - 1] || '').toLowerCase();
}

export function isWslShell(shellPath: string): boolean {
  const base = shellBaseName(shellPath);
  return base === 'wsl.exe' || base === 'wsl';
}

export function isPowerShell(shellPath: string): boolean {
  const base = shellBaseName(shellPath);
  return base.includes('powershell') || base.includes('pwsh');
}

/** bash, zsh and plain sh all take `-l -i -c <cmd>` and quote POSIX-style. */
export function isBashLike(shellPath: string): boolean {
  const base = shellBaseName(shellPath);
  return base.includes('bash') || base.includes('zsh') || base === 'sh';
}

/** The wider POSIX family, for quoting: bash-like plus the newer shells. */
export function quotesPosixStyle(shellPath: string): boolean {
  const base = shellBaseName(shellPath);
  return base.includes('bash') || base.includes('zsh') ||
    base === 'sh' || base === 'dash' || base === 'ksh' ||
    base === 'fish' || base === 'nu' || isWslShell(shellPath);
}

/** Convert a Windows path to the `/mnt/` path a WSL distribution sees. */
export function windowsToWslPath(winPath: string): string {
  if (!winPath) return winPath;
  // C:\Users\foo → /mnt/c/Users/foo
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):(\/.*)/);
  if (match) return '/mnt/' + match[1].toLowerCase() + match[2];
  return normalized;
}
