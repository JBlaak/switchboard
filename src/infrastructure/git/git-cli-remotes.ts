/**
 * `git remote get-url origin` behind the GitRemotes port.
 *
 * Asking git rather than reading `.git/config` is what makes a worktree work:
 * its `.git` is a file pointing back at the main checkout, and git follows it.
 */
import { execFile } from 'node:child_process';
import type { GitRemotes } from '../../application/ports/git-remotes';

export class GitCliRemotes implements GitRemotes {
  originUrl(projectPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], { timeout: 5_000 },
        (err, stdout) => resolve(err ? null : stdout.trim() || null));
    });
  }
}
