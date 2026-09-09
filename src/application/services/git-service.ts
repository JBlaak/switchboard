/**
 * Git, as the app reads it.
 *
 * One method for now, because one surface needs it: the project rail lists a
 * project's worktrees so the session list can be narrowed to one of them.
 * Status and the diff arrive with the surfaces that render them — a cache for
 * either is only worth designing against a real access pattern (how often the
 * rail refreshes, whether a diff is re-read on focus), and guessing at one now
 * would fix the wrong shape. The service exists today so that when they come
 * they have a home that already knows how to run git in both kinds of project.
 *
 * Both kinds: a local folder, where git runs here, and an `ssh://` project,
 * where the same argv runs on the far host. The domain describes the command
 * as data (`localGit`, `remoteGit`); this is the layer that decides where it
 * runs and what its exit code means.
 */
import { gitEnv, localGit, remoteGit } from '../../domain/git/git-argv';
import { parseWorktreeList } from '../../domain/git/worktree-list';
import { isRemoteProjectPath, parseRemoteProjectPath } from '../../domain/project/remote-target';
import type { GitInvocation, Worktree } from '../../domain/git/types';
import type { Logger } from '../ports/logger';
import type { ProcessRunner } from '../ports/process-runner';

export interface GitServiceDeps {
  runner: ProcessRunner;
  log: Logger;
}

/**
 * How long a read may take before it is killed and reported as a failure.
 *
 * `worktree list` reads a handful of files and is over in milliseconds; the
 * bound is for a machine under load or a network filesystem, not for git. The
 * remote bound is longer because it also covers the ssh handshake, which has
 * its own ConnectTimeout inside it.
 */
const LOCAL_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 30_000;

/** git's exit code for every `fatal:` message — for a read, "no repository here". */
const GIT_FATAL = 128;

export class GitService {
  constructor(private readonly deps: GitServiceDeps) {}

  /**
   * Every worktree of the repository at `projectPath`, in git's order.
   *
   * A folder without git is a perfectly valid project — Switchboard tracks
   * anywhere a `claude` session has run — so "not a repository" is an empty
   * list, not an error. git says it with exit 128, the code for every `fatal:`
   * message, which also covers a folder that has since been deleted. Any other
   * non-zero exit is something the user should hear about (a corrupt
   * repository, an ssh host refusing the key) and is thrown with the command's
   * own stderr as the message; the IPC layer turns that into the error
   * envelope. A runner rejection — git missing, the timeout firing — propagates
   * as-is.
   */
  async worktrees(projectPath: string): Promise<Worktree[]> {
    const { runner, log } = this.deps;
    const remote = isRemoteProjectPath(projectPath);
    const invocation = worktreeListInvocation(projectPath);

    // No cwd: `-C` is already in the argv, which is what lets the same command
    // run over ssh, where there is no cwd to set. The env only reaches a local
    // git — ssh does not forward it — which is fine for `worktree list`, a read
    // that never takes the index lock either way.
    const result = await runner.exec(invocation.file, invocation.args, {
      timeoutMs: remote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
      env: gitEnv({}),
    });

    if (result.code === 0) {
      const worktrees = parseWorktreeList(result.stdout);
      log.debug(`[git] ${worktrees.length} worktree(s) in ${projectPath}`);
      return worktrees;
    }
    if (result.code === GIT_FATAL) {
      log.debug(`[git] ${projectPath} is not a git repository`);
      return [];
    }
    const detail = result.stderr.trim() || `${invocation.file} exited with code ${result.code}`;
    log.warn(`[git] worktree list failed in ${projectPath}:`, detail);
    throw new Error(detail);
  }
}

/** The `git worktree list --porcelain` command for this project, wherever it lives. */
function worktreeListInvocation(projectPath: string): GitInvocation {
  const args = ['worktree', 'list', '--porcelain'];
  if (!isRemoteProjectPath(projectPath)) return localGit(projectPath, args);

  const remote = parseRemoteProjectPath(projectPath);
  // The renderer only ever hands back paths the app built, so this is a bug,
  // not a user error — but a bug that should name itself rather than be
  // mistaken for a folder with no repository.
  if (!remote) throw new Error(`not a valid remote project path: ${projectPath}`);
  return remoteGit(remote, remoteGitDir(remote.dir), args);
}

/**
 * The directory `-C` should name on the far host.
 *
 * A remote project's dir is stored the way the user typed it: absolute
 * (`/srv/app`), home-relative (`~/dev/app` or plain `dev/app`), or absent for
 * the login home. The interactive session turns the home-relative forms into
 * `$HOME/…` inside double quotes for the remote shell to expand (see
 * `expandRemoteDir`), but `remoteGit` single-quotes every argument, so that
 * route is closed here: `'$HOME/dev/app'` would reach git as a literal. There
 * is no way to learn the far `$HOME` without a round-trip, and none is needed:
 * sshd starts a command in the user's home directory, so a path relative to
 * the command's own cwd is the same place. `~/dev/app` and `dev/app` both
 * become `dev/app`; no directory at all is `.`.
 */
function remoteGitDir(dir: string | null): string {
  if (!dir || dir === '~') return '.';
  if (dir.startsWith('/')) return dir;
  const rest = dir.startsWith('~/') ? dir.slice(2) : dir;
  return rest || '.';
}
