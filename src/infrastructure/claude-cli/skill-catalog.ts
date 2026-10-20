/**
 * The skills Claude Code would offer a session, read from where it keeps them (#142).
 *
 * Every project gets the user's own (`~/.claude/skills/<name>/SKILL.md`,
 * `~/.claude/commands/**.md`) and those of the plugins enabled in
 * `~/.claude/settings.json` and installed for the user. A project adds its own
 * `.claude/skills` and `.claude/commands`, and the plugins installed for it
 * alone.
 *
 * A plugin's skills are in its `skills/` and `commands/` folders and in the
 * paths its `plugin.json` lists. The CLI's own synced skills
 * (`~/.claude/skills/synced/<account>/…`) are left out, a level too deep to
 * count: their layout is the CLI's private business. A file that can't be
 * read leaves out what it held and nothing more.
 */
import { readSkillFrontmatter, routeSkills } from '../../domain/ask/skills';
import type { RouteSkills, SkillEntry } from '../../domain/ask/skills';
import type { FileSystem } from '../../application/ports/file-system';
import type { Logger } from '../../application/ports/logger';
import type { SkillCatalog } from '../../application/ports/skill-catalog';

export interface ClaudeSkillCatalogDeps {
  fs: FileSystem;
  /** `~/.claude`. */
  claudeDir: string;
  log: Logger;
}

/** One `installed_plugins.json` entry, as far as it is read here. */
interface InstalledPlugin {
  installPath: string;
  scope?: string;
  projectPath?: string;
}

export class ClaudeSkillCatalog implements SkillCatalog {
  constructor(private readonly deps: ClaudeSkillCatalogDeps) {}

  list(projectPaths: string[]): RouteSkills {
    const { fs, claudeDir } = this.deps;
    const wanted = new Set(projectPaths);
    const everywhere = [
      ...this.#skillsIn(fs.join(claudeDir, 'skills')),
      ...this.#commandsIn(fs.join(claudeDir, 'commands')),
    ];
    const byProject: Record<string, SkillEntry[]> = {};
    for (const projectPath of projectPaths) {
      byProject[projectPath] = [
        ...this.#skillsIn(fs.join(projectPath, '.claude', 'skills')),
        ...this.#commandsIn(fs.join(projectPath, '.claude', 'commands')),
      ];
    }

    const enabled = this.#enabledPlugins();
    for (const [key, installs] of Object.entries(this.#installedPlugins())) {
      for (const install of installs) {
        if (install.scope === 'project' || install.scope === 'local') {
          if (install.projectPath && wanted.has(install.projectPath)) {
            byProject[install.projectPath].push(...this.#pluginSkills(key, install.installPath));
          }
        } else if (enabled.has(key)) {
          everywhere.push(...this.#pluginSkills(key, install.installPath));
        }
      }
    }
    return routeSkills(everywhere, byProject);
  }

  /** The skills of one installed plugin, under its name. */
  #pluginSkills(key: string, installPath: string): SkillEntry[] {
    const { fs } = this.deps;
    const manifest = this.#json(fs.join(installPath, '.claude-plugin', 'plugin.json'));
    const plugin = typeof manifest?.name === 'string' ? manifest.name : key.split('@')[0];
    const paths = (field: unknown) => (typeof field === 'string' ? [field] : Array.isArray(field) ? field : [])
      .filter((path): path is string => typeof path === 'string')
      .map(path => fs.join(installPath, path));

    const skills = [fs.join(installPath, 'skills'), ...paths(manifest?.skills)]
      // A listed path is a skill's own folder or a folder of them.
      .flatMap(dir => (fs.exists(fs.join(dir, 'SKILL.md')) ? this.#skill(dir) : this.#skillsIn(dir)));
    const commands = [fs.join(installPath, 'commands'), ...paths(manifest?.commands)]
      .flatMap(dir => this.#commandsIn(dir));
    return [...skills, ...commands].map(entry => ({ ...entry, plugin }));
  }

  /** Each `<dir>/<name>/SKILL.md`. */
  #skillsIn(dir: string): SkillEntry[] {
    return this.#entries(dir)
      .filter(entry => entry.isDirectory)
      .flatMap(entry => this.#skill(this.deps.fs.join(dir, entry.name)));
  }

  /** The skill in one folder, unless the user can't type it. */
  #skill(dir: string): SkillEntry[] {
    const { fs } = this.deps;
    const file = fs.join(dir, 'SKILL.md');
    const text = this.#text(file);
    if (text === null) return [];
    const front = readSkillFrontmatter(text);
    return front.userInvocable ? [{ name: front.name ?? fs.basename(dir) }] : [];
  }

  /** Each `.md` under `dir`; one in a subfolder is typed `/sub:name`. */
  #commandsIn(dir: string, prefix = ''): SkillEntry[] {
    const { fs } = this.deps;
    return this.#entries(dir).flatMap((entry) => {
      if (entry.isDirectory) return this.#commandsIn(fs.join(dir, entry.name), `${prefix}${entry.name}:`);
      if (!entry.isFile || !entry.name.endsWith('.md')) return [];
      const text = this.#text(fs.join(dir, entry.name));
      if (text === null || !readSkillFrontmatter(text).userInvocable) return [];
      return [{ name: `${prefix}${fs.basename(entry.name, '.md')}` }];
    });
  }

  /** The plugins switched on in the user's settings, as `name@marketplace`. */
  #enabledPlugins(): Set<string> {
    const settings = this.#json(this.deps.fs.join(this.deps.claudeDir, 'settings.json'));
    const enabled = settings?.enabledPlugins;
    if (typeof enabled !== 'object' || enabled === null) return new Set();
    return new Set(Object.entries(enabled).filter(([, on]) => on === true).map(([key]) => key));
  }

  /** `installed_plugins.json`'s plugins, each with its installs. */
  #installedPlugins(): Record<string, InstalledPlugin[]> {
    const installed = this.#json(this.deps.fs.join(this.deps.claudeDir, 'plugins', 'installed_plugins.json'));
    const plugins = installed?.plugins;
    if (typeof plugins !== 'object' || plugins === null) return {};
    const out: Record<string, InstalledPlugin[]> = {};
    for (const [key, installs] of Object.entries(plugins)) {
      if (!Array.isArray(installs)) continue;
      out[key] = installs.filter((install): install is InstalledPlugin =>
        typeof install === 'object' && install !== null && typeof install.installPath === 'string');
    }
    return out;
  }

  #entries(dir: string) {
    const { fs } = this.deps;
    if (!fs.isDirectory(dir)) return [];
    try {
      return fs.readDir(dir).filter(entry => !entry.name.startsWith('.'));
    } catch {
      return [];
    }
  }

  #text(path: string): string | null {
    const { fs } = this.deps;
    if (!fs.exists(path)) return null;
    try {
      return fs.readText(path);
    } catch {
      return null;
    }
  }

  #json(path: string): Record<string, unknown> | null {
    const text = this.#text(path);
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      this.deps.log.warn(`[quick-ask] could not read ${path}`);
      return null;
    }
  }
}
