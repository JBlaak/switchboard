/**
 * The argv and environment for every git command Switchboard runs itself.
 *
 * Switchboard only ever reads from git — which worktrees exist, what a branch
 * is called — and does so in directories where a `claude` process may be
 * working at the same moment. Both facts shape the command: it must never
 * block on a pager or a prompt, must never write, and must never get in the
 * way of the git the agent is running.
 */
import { buildSshExecArgv } from '../remote/ssh-command';
import type { RemoteConfig } from '../project/remote-target';
import type { GitInvocation } from './types';

/**
 * The full argv for `git <args>` in `dir`.
 *
 * `-C dir` instead of a spawn cwd, so the same argv works locally and over
 * ssh, where there is no cwd to set. `--no-pager` and `color.ui=false` because
 * the output is parsed, not shown: a pager would hang the process, and colour
 * codes would break the parse.
 */
export function gitArgv(dir: string, args: readonly string[]): string[] {
  return ['--no-pager', '-c', 'color.ui=false', '-C', dir, ...args];
}

/**
 * The environment git should run with, on top of `base`.
 *
 * GIT_OPTIONAL_LOCKS=0 is the important one: even a read like `git status`
 * takes the index lock to refresh stat information, and a `claude` process
 * running `git commit` in the same directory at that moment fails with
 * "index.lock exists". With optional locks off git skips the refresh rather
 * than lock the index from under a running agent. GIT_TERMINAL_PROMPT=0 makes
 * a credential prompt fail instead of hang (there is no terminal to answer
 * it), and GIT_CONFIG_NOSYSTEM keeps a machine-wide config — a pager, a colour
 * override — from changing what we parse. Our values win over `base` for the
 * same reason.
 */
export function gitEnv(base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

/** Run git on this machine, in `dir`. */
export function localGit(dir: string, args: readonly string[]): GitInvocation {
  return { file: 'git', args: gitArgv(dir, args) };
}

/**
 * Run git on the remote host, in `dir` there.
 *
 * `dir` must be a path the remote git can `-C` into as-is: every argument is
 * single-quoted for the far shell, so `~` and `$HOME` will not expand. The
 * absolute paths `git worktree list` prints are exactly that.
 */
export function remoteGit(remote: RemoteConfig, dir: string, args: readonly string[]): GitInvocation {
  return { file: 'ssh', args: buildSshExecArgv(remote, ['git', ...gitArgv(dir, args)]) };
}
