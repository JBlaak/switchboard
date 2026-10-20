/**
 * The skills and slash commands a Quick Ask request may name (#142).
 *
 * Haiku's rewrite turned a skill's own words into a description of what it
 * does ("grill me" became "interview me in rounds…"), and a session can't
 * start a skill from a description: some skills can only be started by their
 * slash command. So the routing call is told which skills exist, by the name
 * their command is typed with, and keeps those names as written.
 *
 * Only names go to Haiku, not descriptions: a description each would cost
 * thousands of tokens on a call the user sits through.
 */

/** One skill or command as found on disk, before it is named. */
export interface SkillEntry {
  /** Its own name: the frontmatter `name`, or its folder or file name. */
  name: string;
  /** The plugin it comes from, if any. */
  plugin?: string;
}

/** The skills a request may name, by slash command, without the `/`. */
export interface RouteSkills {
  /** Available in every project. */
  everywhere: string[];
  /** A project's own skills, beyond `everywhere`, by project path. */
  byProject: Record<string, string[]>;
}

export const NO_SKILLS: RouteSkills = { everywhere: [], byProject: {} };

/** A skill's name and whether the user can type it as a command. */
export interface SkillFrontmatter {
  name?: string;
  /** False only for `user-invocable: false`, which takes it off the `/` menu. */
  userInvocable: boolean;
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The two keys of a SKILL.md or command file's frontmatter that matter here.
 *
 * Not a YAML parser: both are single-line scalars, and a file this can't read
 * still counts, under its folder or file name.
 */
export function readSkillFrontmatter(text: string): SkillFrontmatter {
  const block = text.match(FRONTMATTER)?.[1] ?? '';
  const value = (key: string) => {
    const line = block.split(/\r?\n/).find(row => row.startsWith(`${key}:`));
    return line?.slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  };
  const name = value('name');
  return { ...(name ? { name } : {}), userInvocable: value('user-invocable') !== 'false' };
}

/**
 * The command each entry is typed as, sorted and without repeats.
 *
 * A plugin's skill goes by its own name, as `/grill-me`, unless another entry
 * has that name too; then it needs its plugin's, as `/mattpocock-skills:tdd`.
 * The user's and the project's own skills always keep the plain name.
 */
export function skillCommands(entries: SkillEntry[]): string[] {
  // The same skill found twice (a plugin listing a folder it also has by default) is one skill.
  const unique = [...new Map(entries.map(entry => [`${entry.plugin ?? ''}\0${entry.name}`, entry])).values()];
  const count = new Map<string, number>();
  for (const entry of unique) count.set(entry.name, (count.get(entry.name) ?? 0) + 1);
  const commands = unique.map(entry =>
    entry.plugin && (count.get(entry.name) ?? 0) > 1 ? `${entry.plugin}:${entry.name}` : entry.name);
  return [...new Set(commands)].sort();
}

/**
 * The skills of every project, and each project's own on top.
 *
 * Named together, so a project skill that shares a plugin skill's name pushes
 * that one to its long form there; only what isn't already in `everywhere` is
 * listed under the project.
 */
export function routeSkills(everywhere: SkillEntry[], byProject: Record<string, SkillEntry[]>): RouteSkills {
  const shared = skillCommands(everywhere);
  const known = new Set(shared);
  const own: Record<string, string[]> = {};
  for (const [projectPath, entries] of Object.entries(byProject)) {
    if (entries.length === 0) continue;
    const extra = skillCommands([...everywhere, ...entries]).filter(command => !known.has(command));
    if (extra.length > 0) own[projectPath] = extra;
  }
  return { everywhere: shared, byProject: own };
}

/**
 * Whether `prompt` starts on a skill every project has: `/grill-me`, alone or
 * followed by the rest of the request. Such a prompt needs no project, so it
 * holds for a request Haiku couldn't place.
 */
export function startsOnSharedSkill(prompt: string, skills: RouteSkills | undefined): boolean {
  const command = prompt.trim().match(/^\/(\S+)/)?.[1];
  return command !== undefined && (skills?.everywhere ?? []).includes(command);
}
