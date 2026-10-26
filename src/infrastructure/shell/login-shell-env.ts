/**
 * The PATH the user's own terminal has, for tools Switchboard runs itself.
 *
 * An app started from the Finder inherits launchd's bare PATH, which has no
 * Homebrew in it, so a plain `execFile('gh')` finds nothing even though `gh`
 * works in every terminal. Sessions get the right PATH by running in a login
 * shell; a tool run directly (`gh` for the Session work page) asks that shell
 * for its PATH once and keeps the answer.
 *
 * The same goes for SSH_AUTH_SOCK: a profile that points it at another agent
 * (1Password's) leaves the app with launchd's, which holds no keys, and a
 * `git fetch` over SSH fails "Permission denied (publickey)".
 */
import { execFile } from 'node:child_process';
import { shellArgs } from '../../domain/shell/quoting';
import type { Logger } from '../../application/ports/logger';

const MARKER = '__SWITCHBOARD_PATH__';
const SSH_AUTH_SOCK_MARKER = '__SWITCHBOARD_SSH_AUTH_SOCK__';
const TIMEOUT_MS = 10_000;

/** Where a missing login PATH most likely put the user's tools. */
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The PATH between the markers; an interactive shell may print a banner around it. */
export function pathFromShellOutput(output: string): string | null {
  return betweenMarkers(output, MARKER);
}

/** The SSH agent socket between its markers; null when the shell has none. */
export function sshAuthSockFromShellOutput(output: string): string | null {
  return betweenMarkers(output, SSH_AUTH_SOCK_MARKER);
}

function betweenMarkers(output: string, marker: string): string | null {
  const start = output.indexOf(marker);
  if (start < 0) return null;
  const end = output.indexOf(marker, start + marker.length);
  if (end < 0) return null;
  const found = output.slice(start + marker.length, end).trim();
  return found || null;
}

/** `base` with the fallback directories appended where they are missing. */
export function withFallbackPath(base: string | undefined): string {
  const parts = (base ?? '').split(':').filter(Boolean);
  for (const dir of FALLBACK_DIRS) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(':');
}

/**
 * The base environment with the login shell's PATH and SSH agent, asked for
 * on the first call and remembered. When the shell cannot be asked, the base
 * PATH with Homebrew's usual directories added, and the base agent.
 */
export function loginShellEnv(
  shellPath: () => string,
  baseEnv: Record<string, string>,
  log: Logger,
): () => Promise<Record<string, string>> {
  let env: Promise<Record<string, string>> | null = null;
  return () => {
    env ??= new Promise((resolve) => {
      const shell = shellPath();
      // printenv rather than `echo $PATH`: fish keeps PATH as a list, but
      // exports it colon-joined like every other shell.
      const command = `printf '${MARKER}'; command printenv PATH; printf '${MARKER}';` +
        ` printf '${SSH_AUTH_SOCK_MARKER}'; command printenv SSH_AUTH_SOCK; printf '${SSH_AUTH_SOCK_MARKER}'`;
      execFile(shell, shellArgs(shell, command), { env: baseEnv, timeout: TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout) => {
          const found = pathFromShellOutput(stdout ?? '');
          if (!found) log.warn('[shell] could not read the login shell PATH:', err?.message ?? 'no output');
          const sshAuthSock = sshAuthSockFromShellOutput(stdout ?? '');
          resolve({
            ...baseEnv,
            PATH: found ?? withFallbackPath(baseEnv.PATH),
            ...(sshAuthSock ? { SSH_AUTH_SOCK: sshAuthSock } : {}),
          });
        });
    });
    return env;
  };
}
