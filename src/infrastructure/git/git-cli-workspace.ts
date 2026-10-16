/**
 * The `git` command line behind the GitWorkspace port.
 *
 * Every call is `execFile('git', argv)`: no shell, so a branch or path with
 * spaces or quotes in it is one argument and nothing more. A ref that starts
 * with `-` is refused outright rather than passed, so it can never be read as
 * an option.
 *
 * Each command runs with `GIT_OPTIONAL_LOCKS=0`. Without it `git status` and
 * `git diff` refresh the index and write it back, which is a write Switchboard
 * promised not to make (A1) — and one `watch` would see, report, and cause
 * another read, round and round.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileChange, FileStatus } from '../../domain/session-work/model';
import type { Disposable, GitWorkspace } from '../../application/ports/git-workspace';

/** git's well-known empty tree: what a repository with no commits yet is diffed against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Diffs can be large; anything past this is a diff nobody will read on one page anyway. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const TIMEOUT_MS = 15_000;

/** How many paths go to one `git check-attr`, to stay well under the argv limit. */
const CHECK_ATTR_CHUNK = 200;

/** How long `watch` waits for a burst of writes (a commit touches several files) to settle. */
const WATCH_DEBOUNCE_MS = 100;

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];

interface GitResult {
  /** null when git could not be started, or was killed. */
  code: number | null;
  stdout: string;
}

function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, stdout: stdout ?? '' });
    });
  });
}

/** A ref safe to pass as an argument: not empty, and not something git would read as an option. */
function isSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-');
}

export class GitCliWorkspace implements GitWorkspace {
  async worktreeRoot(cwd: string): Promise<string | null> {
    const result = await git(cwd, ['rev-parse', '--show-toplevel']);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  async defaultBranch(worktree: string): Promise<string> {
    const head = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const fromOrigin = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : '';
    if (fromOrigin) return fromOrigin;

    const refs = await git(worktree, [
      'for-each-ref', '--format=%(refname)',
      'refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master',
    ]);
    const names = refs.code === 0 ? refs.stdout.split('\n').filter(Boolean) : [];
    if (names.some((name) => name.endsWith('/main'))) return 'main';
    if (names.some((name) => name.endsWith('/master'))) return 'master';
    return 'main';
  }

  async branchExists(worktree: string, branch: string): Promise<boolean> {
    if (!isSafeRef(branch)) return false;
    const result = await git(worktree, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
    return result.code === 0;
  }

  async aheadBehind(worktree: string, branch: string, base: string): Promise<{ ahead: number; behind: number }> {
    if (!isSafeRef(branch) || !isSafeRef(base)) return { ahead: 0, behind: 0 };
    // Left is what only `base` has, right what only `branch` has.
    const result = await git(worktree, ['rev-list', '--left-right', '--count', `${base}...${branch}`, '--']);
    const [behind, ahead] = result.code === 0 ? result.stdout.trim().split(/\s+/).map(Number) : [0, 0];
    return { ahead: ahead || 0, behind: behind || 0 };
  }

  async branchDiff(worktree: string, branch: string, base: string): Promise<string> {
    if (!isSafeRef(branch) || !isSafeRef(base)) return '';
    // `a...b` in `git diff` is the diff from their merge-base to `b`.
    const result = await git(worktree, ['diff', ...DIFF_FLAGS, `${base}...${branch}`, '--']);
    return result.code === 0 ? result.stdout : '';
  }

  async status(worktree: string): Promise<FileChange[]> {
    const result = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return result.code === 0 ? parseStatus(result.stdout) : [];
  }

  async workingDiff(worktree: string): Promise<string> {
    const head = await git(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const base = head.code === 0 ? 'HEAD' : EMPTY_TREE;
    const tracked = await git(worktree, ['diff', ...DIFF_FLAGS, base, '--']);
    let diff = tracked.code === 0 ? tracked.stdout : '';

    // Untracked files are not in any diff git keeps, and adding them with
    // `--intent-to-add` would write the index. Diffing each against
    // /dev/null reads the same as a new file, without touching anything.
    const others = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
    const untracked = others.code === 0 ? others.stdout.split('\0').filter(Boolean) : [];
    for (const file of untracked) {
      // `--no-index` exits 1 when the files differ, which here they always do.
      const added = await git(worktree, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', file]);
      if (added.code === 0 || added.code === 1) diff += added.stdout;
    }
    return diff;
  }

  async generatedPaths(worktree: string, paths: readonly string[]): Promise<string[]> {
    const generated: string[] = [];
    for (let i = 0; i < paths.length; i += CHECK_ATTR_CHUNK) {
      const chunk = paths.slice(i, i + CHECK_ATTR_CHUNK);
      const result = await git(worktree, ['check-attr', '-z', 'linguist-generated', '--', ...chunk]);
      if (result.code !== 0) continue;
      // `-z` output is `path NUL attribute NUL value NUL`, repeated.
      const fields = result.stdout.split('\0');
      for (let j = 0; j + 2 < fields.length; j += 3) {
        const value = fields[j + 2];
        if (value === 'set' || value === 'true') generated.push(fields[j]);
      }
    }
    return generated;
  }

  watch(worktree: string, onChange: () => void): Disposable {
    const dirs = gitDirs(worktree);
    const watchers: fs.FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const notify = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) onChange();
      }, WATCH_DEBOUNCE_MS);
    };
    const tryWatch = (target: string, recursive: boolean): boolean => {
      try {
        const watcher = fs.watch(target, { recursive }, notify);
        // A watched directory that goes away (the worktree was removed) is
        // not worth crashing over; it simply stops reporting.
        watcher.on('error', () => watcher.close());
        watchers.push(watcher);
        return true;
      } catch {
        return false;
      }
    };

    if (dirs) {
      // HEAD and index live in the worktree's own git dir, which for a linked
      // worktree is `.git/worktrees/<name>`; refs are shared with the main
      // checkout and live in the common dir.
      tryWatch(dirs.gitDir, false);
      const refs = path.join(dirs.commonDir, 'refs');
      if (!tryWatch(refs, true)) tryWatch(path.join(refs, 'heads'), false);
    }

    return {
      dispose() {
        disposed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        for (const watcher of watchers) watcher.close();
        watchers.length = 0;
      },
    };
  }
}

/**
 * A worktree's own git dir and the common dir it shares with the main checkout.
 *
 * Read off disk rather than asked of git, so `watch` can answer at once: in a
 * linked worktree `.git` is a file saying `gitdir: <path>`, and that directory
 * holds a `commondir` file pointing back at the main `.git`.
 */
function gitDirs(worktree: string): { gitDir: string; commonDir: string } | null {
  const dotGit = path.join(worktree, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!pointer) return null;
    const gitDir = path.resolve(worktree, pointer[1].trim());
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      // No `commondir`: a separate git dir that is its own common dir.
    }
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

/**
 * `git status --porcelain=v1 -z` as file changes.
 *
 * Each entry is `XY path`, and a rename or copy is followed by its old path as
 * the next NUL-separated field. X is the index, Y the worktree; a file staged
 * as new and then edited is still a new file, so the index side wins where
 * they disagree, except that a deletion on either side is a deletion.
 */
export function parseStatus(output: string): FileChange[] {
  const fields = output.split('\0');
  const changes: FileChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const filePath = entry.slice(3);
    if (x === '!' && y === '!') continue;

    let status: FileStatus;
    if (x === '?' && y === '?') status = 'untracked';
    else if (x === 'R' || y === 'R') status = 'renamed';
    else if (x === 'C' || y === 'C') status = 'copied';
    else if (x === 'D' || y === 'D') status = 'deleted';
    else if (x === 'A') status = 'added';
    else status = 'modified';

    const change: FileChange = { path: filePath, status };
    if (status === 'renamed' || status === 'copied') {
      change.oldPath = fields[++i];
    }
    changes.push(change);
  }
  return changes;
}
