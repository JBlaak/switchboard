/**
 * Remote (SSH) project identity.
 *
 * A remote project is identified by an `ssh://` pseudo-path ("ssh://user@host"
 * or "ssh://user@host:2222/dir") so it can flow through every code path that
 * treats projectPath as an opaque string — sidebar ids, settings keys, session
 * maps. Everything here is a pure function of that string: parsing, formatting,
 * validation, and the tmux session name a Switchboard session maps to.
 */

/** SSH coordinates for a project that lives on another host. */
export interface RemoteConfig {
  user: string;
  host: string;
  port: number;
  /** Absent or null when the remote should land in the login home. */
  dir?: string | null;
}

/** A parsed `ssh://` path. Unlike RemoteConfig, `dir` is always present. */
export interface ParsedRemotePath {
  user: string;
  host: string;
  port: number;
  dir: string | null;
}

/** A remote as the user typed it, before validation has settled the defaults. */
export interface RemoteInput {
  user?: string;
  host?: string;
  port?: number | string | null;
  dir?: string | null;
}

export function isRemoteProjectPath(projectPath: unknown): boolean {
  return typeof projectPath === 'string' && projectPath.startsWith('ssh://');
}

/**
 * The working directory is optional; "~" and "" both mean the login home, so
 * they normalize to null and stay out of the identity string.
 */
export function normalizeRemoteDir(dir: unknown): string | null {
  const d = typeof dir === 'string' ? dir.trim().replace(/\/+$/, '') : '';
  return d && d !== '~' ? d : null;
}

export function remoteProjectPath({ user, host, port, dir }: RemoteInput): string {
  const p = Number(port) || 22;
  const base = 'ssh://' + user + '@' + host + (p === 22 ? '' : ':' + p);
  const d = normalizeRemoteDir(dir);
  return d ? base + '/' + d : base;
}

export function parseRemoteProjectPath(projectPath: string | null | undefined): ParsedRemotePath | null {
  const m = /^ssh:\/\/([^@]+)@([^:@/]+)(?::(\d+))?(?:\/(.+))?$/.exec(projectPath || '');
  if (!m) return null;
  return { user: m[1], host: m[2], port: m[3] ? Number(m[3]) : 22, dir: m[4] || null };
}

/**
 * The label a connection card shows: "user@host" plus the directory when set.
 */
export function remoteTargetLabel(remote: RemoteConfig): string {
  const dir = normalizeRemoteDir(remote.dir);
  return remote.user + '@' + remote.host + (dir ? ':' + dir : '');
}

/**
 * user/host/dir end up inside an ssh argv and a remote shell command line;
 * restricting the alphabet up front is simpler than quoting for both layers.
 *
 * Returns the message to show the user, or null when the input is usable.
 */
export function validateRemoteInput({ user, host, port, dir }: RemoteInput = {}): string | null {
  if (!user || !/^[a-zA-Z0-9._-]+$/.test(user)) return 'Username may only contain letters, digits, ".", "_" and "-".';
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) return 'Host must be a hostname or IPv4 address.';
  const p = (port === undefined || port === null || port === '') ? 22 : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be a number between 1 and 65535.';
  const d = normalizeRemoteDir(dir);
  if (d && !/^[a-zA-Z0-9._~/ -]+$/.test(d)) return 'Directory may only contain letters, digits, spaces and ./_~- characters.';
  return null;
}

/** The tmux session on the far end that a Switchboard session id maps to. */
export function tmuxSessionName(sessionId: string): string {
  return 'sb-' + String(sessionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

/**
 * Anchor a remote directory for use inside double quotes in a remote command.
 *
 * `~` has to become `$HOME` by hand there, and a bare relative path is anchored
 * to `$HOME` too — that is what a path typed next to "user@host" naturally
 * means.
 */
export function expandRemoteDir(dir: string): string {
  if (dir.startsWith('/')) return dir;
  const rest = dir.startsWith('~/') ? dir.slice(2) : dir;
  return rest ? '$HOME/' + rest : '$HOME';
}

/**
 * The same directory as `expandRemoteDir` names, but for a one-shot command
 * rather than for an interactive shell.
 *
 * A remote project's dir is stored the way the user typed it: absolute
 * (`/srv/app`), home-relative (`~/dev/app` or plain `dev/app`), or absent for
 * the login home. `expandRemoteDir` hands the home-relative forms to the far
 * shell as `$HOME/…` for it to expand, but the argv builders here single-quote
 * every argument, so that route is closed: `'$HOME/dev/app'` would arrive as a
 * literal directory name.
 *
 * There is no way to learn the far `$HOME` without a round trip, and none is
 * needed. sshd starts a one-shot command in the user's home directory, so a
 * path read relative to that command's own cwd is the same place: `~/dev/app`
 * and `dev/app` both become `dev/app`, and no directory at all is `.`.
 */
export function remoteCommandDir(dir: string | null | undefined): string {
  if (!dir || dir === '~') return '.';
  if (dir.startsWith('/')) return dir;
  const rest = dir.startsWith('~/') ? dir.slice(2) : dir;
  return rest || '.';
}
