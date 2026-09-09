/**
 * Agent files: the markdown a project uses to instruct Claude.
 *
 * They are scattered by design — `~/.claude/CLAUDE.md` for the user, a
 * `CLAUDE.md` in the repo, per-project files under `~/.claude/projects/<folder>/`,
 * slash commands under `.claude/commands/` — and the memory tab's whole job is
 * to gather them into one list. What counts as one, and how the list is
 * ordered, is decided here; finding them is the adapter's job.
 */

/** One agent file as the memory tab lists it. */
export interface AgentFile {
  filename: string;
  filePath: string;
  /** ISO-8601 mtime. */
  modified: string;
  /** Where it lives, shortened for display ("~/.claude", "dev/app/.claude/"). */
  displayPath?: string;
  /** 'claude-home' for files under ~/.claude, 'project' for ones in the repo. */
  source?: 'claude-home' | 'project';
  [key: string]: unknown;
}

/** The agent files of one project. */
export interface AgentFileGroup {
  folder: string;
  projectPath: string;
  shortName: string;
  files: AgentFile[];
}

/** The memory tab's contents: the user's own files plus one group per project. */
export interface AgentFileIndex {
  global: { files: AgentFile[] };
  projects: AgentFileGroup[];
}

/** The label the user's own `~/.claude` files are shown under. */
export const CLAUDE_HOME_LABEL = '~/.claude';

/**
 * Instruction files looked for in a project's root.
 *
 * `agents.md` and `GEMINI.md` are here because a repo shared between tools
 * often has one of those rather than a `CLAUDE.md`, and the memory tab is more
 * useful for showing whichever the project actually uses.
 */
export const PROJECT_ROOT_AGENT_FILES = ['CLAUDE.md', 'GEMINI.md', 'agents.md'];

/** The newest file in a group — what the group is ordered by. */
export function newestModified(files: readonly AgentFile[]): number {
  let newest = 0;
  for (const file of files) {
    const at = new Date(file.modified).getTime();
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

/** Projects with recently touched files first. */
export function byNewestFileFirst(a: AgentFileGroup, b: AgentFileGroup): number {
  return newestModified(b.files) - newestModified(a.files);
}

/**
 * Every file in the index, tagged with the group it belongs to.
 *
 * The search index wants one flat list with a human label per row, which is not
 * the shape the tab renders from.
 */
export function flattenForSearch(index: AgentFileIndex): { file: AgentFile; label: string }[] {
  return [
    ...index.global.files.map(file => ({ file, label: 'Global' })),
    ...index.projects.flatMap(p => p.files.map(file => ({ file, label: p.shortName }))),
  ];
}
