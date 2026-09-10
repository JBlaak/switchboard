/**
 * Reading a project's working tree: one directory at a time, and one file.
 *
 * This is what the Files tab asks for, and it is deliberately not the viewer
 * panel's file access (`readFileForPanel`). That path takes any absolute path
 * the renderer hands it, because the paths it gets came from the CLI over MCP
 * or from a link in terminal output. A tree is different: the renderer walks
 * it, so the path is assembled from names the user clicked, and one `..`
 * anywhere in that chain would turn the tab into a reader for the whole disk.
 * Every path here is therefore relative to the worktree and checked against it
 * before anything is opened.
 *
 * Two more rules shape it. Only one level is ever read, because a recursive
 * scan of a monorepo would block the main process for seconds. And what git
 * ignores is not shown, because a tree whose first screen is `node_modules`
 * and `dist` is a tree nobody can find their code in — so every listing runs
 * one `git check-ignore` over the names it just read.
 *
 * Both kinds of project, as everywhere else: a local folder, read through the
 * filesystem port, and an `ssh://` project, read by running `ls` and `cat` on
 * the far host through the same process runner git uses.
 */
import { buildSshExecArgv } from '../../domain/remote/ssh-command';
import { gitEnv, localGit, remoteGit } from '../../domain/git/git-argv';
import { isRemoteProjectPath, parseRemoteProjectPath, remoteCommandDir } from '../../domain/project/remote-target';
import type { BrowseEntry, BrowseFile, BrowseListing } from '../../domain/browse/types';
import type { GitInvocation } from '../../domain/git/types';
import type { ParsedRemotePath } from '../../domain/project/remote-target';
import type { FileSystem } from '../ports/file-system';
import type { Logger } from '../ports/logger';
import type { ProcessRunner } from '../ports/process-runner';

export interface BrowseServiceDeps {
  fs: FileSystem;
  runner: ProcessRunner;
  log: Logger;
}

/**
 * How long a read may take before it is killed. The same bounds the git
 * integration uses: generous for a machine under load, and the remote one
 * longer because it also covers the ssh handshake.
 */
const LOCAL_TIMEOUT_MS = 15_000;
const REMOTE_TIMEOUT_MS = 30_000;

/** git's exit code for every `fatal:` — here, "this is not a repository". */
const GIT_FATAL = 128;

/** `git check-ignore`'s way of saying "none of these are ignored". Not a failure. */
const GIT_NOTHING_MATCHED = 1;

/**
 * The largest file the tab will open.
 *
 * IPC copies the whole string into the renderer and CodeMirror then builds a
 * document from it, so a 200 MB log would freeze both processes before anyone
 * saw a character. Refusing with a message the UI can print is the honest
 * answer; there is no partial view worth showing for a file this size.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Our own exit code for the remote size check, so it reads as itself below. */
const REMOTE_TOO_LARGE = 3;

/**
 * Never shown, repository or not: `.git` is the repository's own bookkeeping,
 * and git will not report it as ignored because it never considers it a file
 * at all.
 */
const NEVER_LISTED = new Set(['.git']);

/**
 * What is hidden when git could not answer — a folder that is not a
 * repository, or a machine without git. Not a general ignore list: inside a
 * repository the `.gitignore` files decide, and a project that checks its
 * dependencies in should see them.
 */
const HIDDEN_WITHOUT_GIT = new Set([...NEVER_LISTED, 'node_modules']);

/** Names on stdin, ignored names on stdout, NUL-separated so a newline in one is safe. */
const CHECK_IGNORE = ['check-ignore', '-z', '--stdin'];

export class BrowseService {
  constructor(private readonly deps: BrowseServiceDeps) {}

  /**
   * The direct children of `relPath` inside `worktreePath`, ready to render:
   * ignored names dropped, directories first, then case-insensitive by name.
   *
   * `relPath` is relative to the worktree; `''` is the worktree itself.
   * A directory that cannot be read answers `{ entries: [], unreadable: true }`
   * — a tree is read while the user is working in it, so a folder that a
   * `git checkout` removed a moment ago is an ordinary event, not an error.
   * A path that tries to leave the worktree is the exception that throws: that
   * is not a state the tree can be in by walking it.
   */
  async listDir(worktreePath: string, relPath: string): Promise<BrowseListing> {
    const rel = insideRelativePath(relPath);
    return isRemoteProjectPath(worktreePath)
      ? this.#listRemote(worktreePath, rel)
      : this.#listLocal(worktreePath, rel);
  }

  /**
   * The text of one file inside the worktree.
   *
   * Answers `{ error }` rather than throwing for everything the user can cause
   * — a file that is gone, a directory, a file too large to send — because the
   * tab shows those in place of the editor. The path guard still throws, for
   * the same reason as in `listDir`.
   */
  async readFile(worktreePath: string, relPath: string): Promise<BrowseFile> {
    const rel = insideRelativePath(relPath);
    return isRemoteProjectPath(worktreePath)
      ? this.#readRemote(worktreePath, rel)
      : this.#readLocal(worktreePath, rel);
  }

  // ── Local ──

  async #listLocal(worktreePath: string, rel: string): Promise<BrowseListing> {
    const { fs, log } = this.deps;
    const dir = localTarget(fs, worktreePath, rel);

    let listed;
    try {
      listed = fs.readDir(dir);
    } catch (err) {
      const message = (err as Error).message;
      log.debug(`[browse] ${dir} could not be listed:`, message);
      return { entries: [], unreadable: true, error: message };
    }

    const entries = listed.map(entry => ({
      name: entry.name,
      // A symlink is neither: `readDir` does not follow it, and neither do we,
      // so the tree shows it as a leaf. Following one would let a link inside
      // the worktree walk the tree out of it, past the guard above — the guard
      // compares paths, and a path through a symlink still looks like a child.
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymbolicLink,
    }));

    const ignored = await this.#ignoredNames(
      localGit(dir, CHECK_IGNORE), entries.map(e => e.name), LOCAL_TIMEOUT_MS,
    );
    return { entries: visible(entries, ignored).sort(byDirectoriesThenName) };
  }

  async #readLocal(worktreePath: string, rel: string): Promise<BrowseFile> {
    const { fs } = this.deps;
    const file = localTarget(fs, worktreePath, rel);

    const stat = fs.stat(file);
    if (stat && stat.size > MAX_FILE_BYTES) return { error: tooLargeMessage(stat.size) };
    try {
      return { content: fs.readText(file) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  // ── Remote ──

  async #listRemote(projectPath: string, rel: string): Promise<BrowseListing> {
    const { runner, log } = this.deps;
    const remote = remoteOrThrow(projectPath);
    const dir = remotePath(remote, rel);

    // `ls -1Ap`: one name per line, dotfiles included, a trailing `/` on every
    // directory. That slash is the only type information in the output — it
    // cannot say whether a name is a symlink (and a link to a directory is
    // marked like the directory it points at), which is why a remote listing
    // reports `isSymbolicLink: false` throughout. A newline inside a filename
    // would also split into two entries; the alternative is `find -print0`,
    // whose output the far end's find may or may not support, and a filename
    // with a newline in it is not worth that trade.
    const result = await runner.exec('ssh', buildSshExecArgv(remote, ['ls', '-1Ap', '--', dir]), {
      timeoutMs: REMOTE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      // ssh writes its own failures to stderr — `Permission denied (publickey)`,
      // `Connection refused`, a timed-out handshake — and they are the sentence
      // the panel has to print, so they travel with the answer.
      const message = result.stderr.trim() || `exit ${result.code}`;
      log.debug(`[browse] remote ${dir} could not be listed:`, message);
      return { entries: [], unreadable: true, error: message };
    }

    const entries = parseLsOutput(result.stdout);
    const ignored = await this.#ignoredNames(
      remoteGit(remote, dir, CHECK_IGNORE), entries.map(e => e.name), REMOTE_TIMEOUT_MS,
    );
    return { entries: visible(entries, ignored).sort(byDirectoriesThenName) };
  }

  async #readRemote(projectPath: string, rel: string): Promise<BrowseFile> {
    const { runner } = this.deps;
    const remote = remoteOrThrow(projectPath);
    const file = remotePath(remote, rel);

    // The size check has to happen on the far side. `cat` alone would pull a
    // gigabyte across the link before we could refuse it, and `head -c` would
    // hand back a silently truncated file — so one `sh -c` measures first and
    // only then prints, and says which of the two happened with its exit code.
    // `"$1"` is a positional parameter, so the path is data to that shell
    // rather than something it parses.
    const script =
      'n=$(wc -c < "$1") || exit 1; '
      + `if [ "$n" -gt ${MAX_FILE_BYTES} ]; then echo "$n" >&2; exit ${REMOTE_TOO_LARGE}; fi; `
      + 'cat -- "$1"';
    const result = await runner.exec('ssh', buildSshExecArgv(remote, ['sh', '-c', script, 'sh', file]), {
      timeoutMs: REMOTE_TIMEOUT_MS,
    });

    if (result.code === REMOTE_TOO_LARGE) return { error: tooLargeMessage(Number(result.stderr.trim())) };
    if (result.code !== 0) {
      return { error: result.stderr.trim() || `reading ${file} on ${remote.host} exited with code ${result.code}` };
    }
    // Read-only because there is no remote write: saving would need the same
    // round trip in reverse, with a conflict story to go with it.
    return { content: result.stdout, readOnly: true };
  }

  // ── git ──

  /**
   * Which of `names` git ignores in that directory, or null when git could not
   * answer at all.
   *
   * One spawn per listing, whatever the directory holds: the names go in on
   * stdin and only the ignored ones come back, which is also why the `-z`
   * framing matters — a filename may contain anything but a NUL.
   *
   * Exit 1 is git saying "none of them", which is a perfectly good answer and
   * the reason the port resolves on any exit code. Exit 128 is "not a
   * repository" — an ordinary kind of project here, since Switchboard tracks
   * anywhere a session has run — and so is a missing git or an ssh that could
   * not connect: null, and the caller falls back to hiding the handful of
   * names nobody wants to see. Browsing a folder does not depend on git being
   * there.
   *
   * The environment only reaches a local git, since ssh does not forward it.
   * That is fine for this read: `check-ignore` consults the ignore files and
   * never takes the index lock either way.
   */
  async #ignoredNames(
    invocation: GitInvocation, names: readonly string[], timeoutMs: number,
  ): Promise<Set<string> | null> {
    if (names.length === 0) return new Set();
    const { runner, log } = this.deps;

    let result;
    try {
      result = await runner.exec(invocation.file, invocation.args, {
        timeoutMs,
        stdin: names.join('\0'),
        env: gitEnv({}),
      });
    } catch (err) {
      log.warn('[browse] check-ignore could not be run:', (err as Error).message);
      return null;
    }

    if (result.code === 0) return new Set(result.stdout.split('\0').filter(Boolean));
    if (result.code === GIT_NOTHING_MATCHED) return new Set();
    if (result.code !== GIT_FATAL) {
      log.debug(`[browse] check-ignore exited with code ${result.code}:`, result.stderr.trim());
    }
    return null;
  }
}

/**
 * `relPath`, normalized to a path that cannot leave the worktree.
 *
 * A leading `/` is forgiven — a tree naturally names its root that way — but a
 * `..` segment is not: there is no walk through the tree that produces one, so
 * seeing one means either a bug in the caller or someone using the tab as a
 * reader for the rest of the disk. Backslashes count as separators too, so a
 * Windows-shaped `..\..` cannot slip past on a machine where `\` is one.
 */
function insideRelativePath(relPath: string): string {
  const parts = String(relPath ?? '').split(/[\\/]+/).filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) {
    throw new Error(`path leaves the project: ${relPath}`);
  }
  return parts.join('/');
}

/**
 * The absolute local path, checked once more against the worktree.
 *
 * Belt and braces over `insideRelativePath`: that one reasons about the string
 * the renderer sent, this one about the path the filesystem will actually open,
 * which is the thing that has to be inside the project.
 */
function localTarget(fs: FileSystem, worktreePath: string, rel: string): string {
  const target = fs.resolve(rel ? fs.join(worktreePath, rel) : worktreePath);
  if (!fs.isInside(worktreePath, target)) {
    throw new Error(`path leaves the project: ${rel}`);
  }
  return target;
}

/** The renderer only ever hands back paths the app built, so this is a bug naming itself. */
function remoteOrThrow(projectPath: string): ParsedRemotePath {
  const remote = parseRemoteProjectPath(projectPath);
  if (!remote) throw new Error(`not a valid remote project path: ${projectPath}`);
  return remote;
}

/**
 * The path to name on the far host: the project's own directory as a one-shot
 * command sees it (`remoteCommandDir`), with `rel` hung off it.
 *
 * `.` is what that helper calls the login home, and joining onto it would give
 * `./src` — harmless, but the git integration passes the same string to `-C`
 * and the two should spell the same directory the same way.
 */
function remotePath(remote: ParsedRemotePath, rel: string): string {
  const base = remoteCommandDir(remote.dir);
  if (base === '.') return rel || '.';
  return rel ? `${base.replace(/\/+$/, '')}/${rel}` : base;
}

/** `ls -1Ap` output: one name per line, a trailing slash on the directories. */
function parseLsOutput(stdout: string): BrowseEntry[] {
  return stdout.split('\n')
    .filter(Boolean)
    .map(line => (line.endsWith('/')
      ? { name: line.slice(0, -1), isDirectory: true, isSymbolicLink: false }
      : { name: line, isDirectory: false, isSymbolicLink: false }));
}

/** Everything git did not claim, or — when git could not answer — everything but the usual suspects. */
function visible(entries: readonly BrowseEntry[], ignored: Set<string> | null): BrowseEntry[] {
  const hidden = ignored ?? HIDDEN_WITHOUT_GIT;
  return entries.filter(entry => !NEVER_LISTED.has(entry.name) && !hidden.has(entry.name));
}

/**
 * Directories first, then by name ignoring case — the order a file tree is
 * read in. The comparison is on lowercased code points rather than
 * `localeCompare`, so `README` and `readme` land in the same order on every
 * machine instead of following the OS locale; equal but for case, the raw
 * names break the tie so the order is total.
 */
function byDirectoriesThenName(a: BrowseEntry, b: BrowseEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The refusal, as the tab will print it. The size is included so it is not a mystery. */
function tooLargeMessage(size: number): string {
  const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
  const measured = Number.isFinite(size) && size > 0 ? ` (${mb(size)} MB)` : '';
  return `This file${measured} is too large to open here; the limit is ${mb(MAX_FILE_BYTES)} MB.`;
}
