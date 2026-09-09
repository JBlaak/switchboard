/**
 * Project paths: the identity rules for a project directory.
 *
 * A project is identified by its absolute path (or an `ssh://` pseudo-path for
 * a remote one), and Claude CLI keeps its transcripts in a directory whose name
 * is that path with every non-alphanumeric character replaced. Both directions
 * of that mapping live here, along with the display shortening every surface
 * needs, so no caller has to re-derive the encoding.
 */

/**
 * Mirror Claude CLI's project-folder naming, so a folder Switchboard creates
 * matches the one the CLI writes for the same project path.
 *
 * Reverse-engineered from claude CLI 2.1.126. The hash suffix is the CLI's own
 * collision guard for paths long enough to be truncated.
 */
export function encodeProjectPath(projectPath: string): string {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h << 5) - h + projectPath.charCodeAt(i) | 0;
  }
  return sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

/**
 * A last-resort label for a folder whose project path could not be resolved.
 *
 * The encoding is lossy — every separator became a `-` — so this can only guess
 * at the last two segments ("-Users-home-dev-MyClaude" → "dev/MyClaude"). Used
 * only when no transcript in the folder carries a `cwd`.
 */
export function folderToShortPath(folder: string): string {
  const parts = folder.replace(/^-/, '').split('-').filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * Shorten a project path for display: its last two segments.
 *
 * Splits on both separators. projectPath comes from a session's `cwd`, which on
 * Windows is backslash-separated — splitting on '/' alone finds no separator, so
 * every "short" label rendered the entire path.
 */
export function shortProjectPath(projectPath: string | null | undefined): string {
  if (!projectPath) return '';
  // Remote projects render as their connection string ("user@host[:port]"),
  // plus the last segment of the working directory when one is set.
  if (projectPath.startsWith('ssh://')) {
    const rest = projectPath.slice('ssh://'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return rest;
    const lastSeg = rest.slice(slash + 1).split('/').filter(s => s && s !== '~').pop();
    return lastSeg ? rest.slice(0, slash) + '/' + lastSeg : rest.slice(0, slash);
  }
  return projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

/**
 * The project a worktree belongs to, if this cwd is one.
 *
 * Claude CLI's `--worktree` puts a session in `<project>/.claude-worktrees/<name>`
 * (and two older variants), which would otherwise show up as a project of its
 * own next to the repo it was cut from. Returns the parent path to attribute the
 * session to, or null when the cwd is not a worktree — the caller confirms the
 * parent still exists, since only it can touch the filesystem.
 */
export function worktreeParentPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const match = cwd.match(/^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/[^/]+\/?$/);
  return match ? match[1] : null;
}
