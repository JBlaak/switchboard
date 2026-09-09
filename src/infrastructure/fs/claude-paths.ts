/**
 * Where Claude Code keeps its things.
 *
 * One place, so a layout change is one edit rather than a grep. None of these
 * are ours to own — the CLI writes them and may move them — which is why they
 * are read through ports everywhere above this.
 */
import os from 'node:os';
import path from 'node:path';

export interface ClaudePaths {
  /** `~/.claude`. */
  readonly claudeDir: string;
  /** `~/.claude/projects` — one directory per project, holding transcripts. */
  readonly projectsDir: string;
  /** `~/.claude/plans` — the markdown plans the CLI writes. */
  readonly plansDir: string;
  /** `~/.claude/commands` — the user's own slash commands. */
  readonly commandsDir: string;
  /** `~/.claude/ide` — the lock files editors advertise themselves through. */
  readonly ideDir: string;
  /** `~/.claude/stats-cache.json` — what `/stats` leaves behind. */
  readonly statsCachePath: string;
  readonly homeDir: string;
}

/**
 * Resolve the layout.
 *
 * Anchored on `~/.claude` rather than on the CLI's own CLAUDE_CONFIG_DIR
 * override. Honouring that override would be more correct in principle, but a
 * user who has it set for an unrelated reason would find every session gone
 * after an update — so it is read only where it always was, when locating the
 * stored credentials.
 */
export function resolveClaudePaths(): ClaudePaths {
  const homeDir = os.homedir();
  const claudeDir = path.join(homeDir, '.claude');
  return {
    homeDir,
    claudeDir,
    projectsDir: path.join(claudeDir, 'projects'),
    plansDir: path.join(claudeDir, 'plans'),
    commandsDir: path.join(claudeDir, 'commands'),
    ideDir: path.join(claudeDir, 'ide'),
    statsCachePath: path.join(claudeDir, 'stats-cache.json'),
  };
}

/**
 * Directories inside `~/.claude/projects` that are not projects.
 *
 * `.git` turns up because people put their whole `~/.claude` under version
 * control.
 */
export function isProjectFolderName(name: string): boolean {
  return name !== '.git';
}
