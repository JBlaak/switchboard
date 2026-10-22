/**
 * Checking a folder before it is added as a project (#171).
 *
 * The Projects modal shows what a typed or pasted path would give: whether it
 * is there, whether it is a git repository and on which branch, and whether
 * that repository is on GitHub (which is what plans and pull requests need).
 * It also completes the path on Tab. Reads only: adding stays with the
 * add-project handler.
 */
import {
  completePath, completionTarget, expandHome,
} from '../../domain/project/folder-check';
import { gitHubRepository } from '../../domain/project/repo-url';
import type { ProjectFolderCheck } from '../../domain/project/folder-check';
import type { FileSystem } from '../ports/file-system';
import type { GitRemotes } from '../ports/git-remotes';
import type { GitWorkspace } from '../ports/git-workspace';

export interface ProjectFolderServiceDeps {
  fs: Pick<FileSystem, 'exists' | 'isDirectory' | 'readDir' | 'homeDir'>;
  git: Pick<GitWorkspace, 'worktreeRoot' | 'currentBranch'>;
  remotes: GitRemotes;
}

export class ProjectFolderService {
  constructor(private readonly deps: ProjectFolderServiceDeps) {}

  /** What `typed` points at, read the way the user typed it. */
  async check(typed: string): Promise<ProjectFolderCheck> {
    const text = typed.trim();
    const path = this.#expand(text).replace(/(.)\/+$/, '$1');
    const exists = text !== '' && this.deps.fs.exists(path);
    const directory = exists && this.deps.fs.isDirectory(path);
    const completion = this.#complete(text);
    if (!directory) {
      return { path, exists, directory, git: false, branch: null, gitHubRepository: null, completion };
    }

    const root = await this.deps.git.worktreeRoot(path);
    if (!root) return { path, exists, directory, git: false, branch: null, gitHubRepository: null, completion };
    const [branch, origin] = await Promise.all([
      this.deps.git.currentBranch(root),
      this.deps.remotes.originUrl(root),
    ]);
    return {
      path, exists, directory, git: true, branch,
      gitHubRepository: (origin && gitHubRepository(origin)) || null,
      completion,
    };
  }

  #expand(text: string): string {
    return expandHome(text, this.deps.fs.homeDir);
  }

  /** The folders beside the last `/` of `text` that could complete it. */
  #complete(text: string): string | null {
    const target = completionTarget(text);
    if (!target) return null;
    const folder = this.#expand(target.folder);
    if (!this.deps.fs.isDirectory(folder)) return null;
    let names: string[];
    try {
      names = this.deps.fs.readDir(folder).filter(entry => entry.isDirectory).map(entry => entry.name);
    } catch {
      return null;
    }
    return completePath(text, names);
  }
}
