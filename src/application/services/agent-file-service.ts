/**
 * The memory tab: every markdown file that instructs Claude, gathered up.
 *
 * They live in four places per project and one place globally, and the same
 * file can be reachable through two of them — `~/.claude/projects/<folder>/`
 * often mirrors what is in the repo. So the scan is ordered by authority
 * (claude-home first, then the repo) and deduplicated by resolved path, which
 * is what stops the same CLAUDE.md appearing twice under different labels.
 */
import {
  byNewestFileFirst, CLAUDE_HOME_LABEL, flattenForSearch, PROJECT_ROOT_AGENT_FILES,
} from '../../domain/agent-files/agent-file';
import { folderToShortPath, shortProjectPath } from '../../domain/project/project-path';
import type { AgentFile, AgentFileGroup, AgentFileIndex } from '../../domain/agent-files/agent-file';
import type { FileSystem } from '../ports/file-system';
import type { Logger } from '../ports/logger';
import type { SearchIndex } from '../ports/search-index';
import type { TranscriptStore } from '../ports/transcript-store';
import type { SettingsService } from './settings-service';

export interface AgentFileServiceDeps {
  fs: FileSystem;
  transcripts: TranscriptStore;
  settings: SettingsService;
  searchIndex: SearchIndex;
  log: Logger;
  /** `~/.claude`. */
  claudeDir: string;
  /** `~/.claude/projects`. */
  projectsDir: string;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export class AgentFileService {
  constructor(private readonly deps: AgentFileServiceDeps) {}

  /** Every agent file, grouped and indexed for search. */
  index(): AgentFileIndex {
    const hidden = this.deps.settings.hiddenProjects();

    const index: AgentFileIndex = {
      global: {
        files: this.#markdownIn(this.deps.claudeDir)
          .map(file => ({ ...file, displayPath: CLAUDE_HOME_LABEL })),
      },
      projects: this.#scanProjects(hidden),
    };

    index.projects.sort(byNewestFileFirst);
    this.#reindex(index);
    return index;
  }

  /**
   * Read one agent file.
   *
   * The path comes from the renderer, so it is constrained: it has to be a
   * markdown file, and one that is either under `~/.claude` or actually there.
   */
  read(filePath: string): string {
    const { fs, claudeDir, log } = this.deps;
    try {
      const resolved = fs.resolve(filePath);
      if (!resolved.endsWith('.md')) return '';
      if (!fs.isInside(claudeDir, resolved) && !fs.exists(resolved)) return '';
      return fs.readText(resolved);
    } catch (err) {
      log.error('[memory] could not read file:', (err as Error).message);
      return '';
    }
  }

  /** Overwrite an agent file that already exists — never create a new one. */
  save(filePath: string, content: string): SaveResult {
    const { fs, log } = this.deps;
    try {
      const resolved = fs.resolve(filePath);
      if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
      if (!fs.exists(resolved)) return { ok: false, error: 'file does not exist' };
      fs.writeText(resolved, content);
      return { ok: true };
    } catch (err) {
      log.error('[memory] could not save file:', (err as Error).message);
      return { ok: false, error: (err as Error).message };
    }
  }

  #scanProjects(hidden: ReadonlySet<string>): AgentFileGroup[] {
    const { fs, transcripts, projectsDir, log } = this.deps;
    const groups: AgentFileGroup[] = [];

    let folders: string[];
    try {
      folders = transcripts.listFolders();
    } catch (err) {
      log.error('[memory] could not list projects:', (err as Error).message);
      return groups;
    }

    for (const folder of folders) {
      const projectPath = transcripts.resolveProjectPath(folder)?.projectPath ?? null;
      if (projectPath && hidden.has(projectPath)) continue;

      // The same two-deep label the sessions tab uses. Falls back to decoding
      // the folder name, which is lossy but better than nothing.
      const shortName = projectPath ? shortProjectPath(projectPath) : folderToShortPath(folder);

      const files: AgentFile[] = [];
      const seen = new Set<string>();
      const add = (file: AgentFile): void => {
        if (seen.has(file.filePath)) return;
        seen.add(file.filePath);
        files.push(file);
      };

      // 1. The claude-home side: `~/.claude/projects/<folder>/` and its memory/.
      const folderPath = fs.join(projectsDir, folder);
      for (const file of this.#markdownIn(folderPath)) {
        add({ ...file, displayPath: CLAUDE_HOME_LABEL, source: 'claude-home' });
      }
      for (const file of this.#markdownIn(fs.join(folderPath, 'memory'))) {
        add({ ...file, displayPath: CLAUDE_HOME_LABEL, source: 'claude-home' });
      }

      // 2. The repo side: instruction files in the root, then `.claude/`.
      if (projectPath) {
        for (const name of PROJECT_ROOT_AGENT_FILES) {
          const file = this.#namedFile(projectPath, name, shortName + '/');
          if (file) add(file);
        }
        const dotClaude = fs.join(projectPath, '.claude');
        for (const file of this.#markdownIn(dotClaude)) {
          add({ ...file, displayPath: shortName + '/.claude/', source: 'project' });
        }
        for (const file of this.#markdownIn(fs.join(dotClaude, 'commands'))) {
          add({ ...file, displayPath: shortName + '/.claude/commands/', source: 'project' });
        }
      }

      if (files.length) {
        groups.push({ folder, projectPath: projectPath || '', shortName, files });
      }
    }

    return groups;
  }

  /**
   * The non-empty markdown files directly in a directory.
   *
   * Empty files are skipped: the CLI creates placeholders, and a memory tab
   * full of files with nothing in them is noise.
   */
  #markdownIn(dir: string): AgentFile[] {
    const { fs } = this.deps;
    const files: AgentFile[] = [];
    if (!fs.exists(dir)) return files;
    try {
      for (const entry of fs.readDir(dir)) {
        if (!entry.isFile || !entry.name.endsWith('.md')) continue;
        const filePath = fs.join(dir, entry.name);
        try {
          if (!fs.readText(filePath).trim()) continue;
          const stat = fs.stat(filePath);
          if (!stat) continue;
          files.push({ filename: entry.name, filePath, modified: stat.modifiedIso });
        } catch {
          // Unreadable file — skip it rather than dropping the directory.
        }
      }
    } catch {
      // Directory vanished mid-scan.
    }
    return files;
  }

  /** One specific file in a project's root, if it exists and has content. */
  #namedFile(projectPath: string, name: string, displayPath: string): AgentFile | null {
    const { fs } = this.deps;
    const filePath = fs.join(projectPath, name);
    try {
      if (!fs.exists(filePath)) return null;
      if (!fs.readText(filePath).trim()) return null;
      const stat = fs.stat(filePath);
      if (!stat) return null;
      return { filename: name, filePath, modified: stat.modifiedIso, displayPath, source: 'project' };
    } catch {
      return null;
    }
  }

  #reindex(index: AgentFileIndex): void {
    const { fs, searchIndex, log } = this.deps;
    try {
      searchIndex.deleteType('memory');
      searchIndex.upsert(flattenForSearch(index).map(({ file, label }) => ({
        id: file.filePath,
        type: 'memory' as const,
        folder: null,
        title: label + ' ' + file.filename,
        body: fs.readText(file.filePath),
      })));
    } catch (err) {
      log.warn('[memory] could not index agent files:', (err as Error).message);
    }
  }
}
