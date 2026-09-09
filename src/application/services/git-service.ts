/**
 * Git, as the app reads it.
 *
 * Two questions, and the shape of the answers is the design. *Which worktrees
 * exist* is what the project rail asks, so the session list can be narrowed to
 * one checkout. *What changed in one* is what the code side asks, and it asks
 * it in two phases:
 *
 *  - `changedFiles` runs one cheap command for the whole tree — sizes and
 *    statuses, no content — and classifies what comes back. A session that has
 *    just regenerated `package-lock.json` is therefore known to be twelve
 *    thousand lines *without buying those twelve thousand lines*, which is the
 *    only way the file list can decide to collapse it.
 *  - `diffFile` buys the lines, for one file, when someone opens it.
 *
 * There is deliberately no method that returns the whole diff with hunks. The
 * migration commit that renamed every file in this repository is a
 * multi-megabyte patch; reading it to render twelve visible file headers would
 * block the main process, cross IPC whole, and be thrown away on the next
 * refresh.
 *
 * Both kinds of project, as everywhere else: a local folder, where git runs
 * here, and an `ssh://` project, where the same argv runs on the far host. The
 * domain describes the command as data (`localGit`, `remoteGit`); this is the
 * layer that decides where it runs and what its exit code means.
 */
import { isGenerated, isOversized, parseGitattributesGenerated } from '../../domain/git/classify';
import { gitEnv, localGit, remoteGit } from '../../domain/git/git-argv';
import { parseNumstat, parseRawDiff } from '../../domain/git/numstat-parse';
import { parseStatus, parseStatusBranch } from '../../domain/git/status-parse';
import { parseUnifiedDiff } from '../../domain/git/diff-parse';
import { parseWorktreeList } from '../../domain/git/worktree-list';
import { SUBMODULE_MODE } from '../../domain/git/types';
import {
  isRemoteProjectPath, parseRemoteProjectPath, remoteCommandDir,
} from '../../domain/project/remote-target';
import type { GeneratedAttributes } from '../../domain/git/classify';
import type {
  DiffBase, DiffResult, FileDiff, FileStatus, GitInvocation, NumstatEntry, StatusBranch, Worktree,
} from '../../domain/git/types';
import type { FileSystem } from '../ports/file-system';
import type { Logger } from '../ports/logger';
import type { ExecResult, ProcessRunner } from '../ports/process-runner';

export interface GitServiceDeps {
  runner: ProcessRunner;
  log: Logger;
  /**
   * Only used to read one file — the worktree's `.gitattributes`, for the
   * `linguist-generated` rule. Optional because the composition root does not
   * pass it yet, and because there is nothing to read on a remote worktree
   * anyway: without it every other classification rule still applies, so the
   * degradation is one rule, not a broken surface.
   */
  fs?: FileSystem;
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

/**
 * The same thing `GIT_OPTIONAL_LOCKS=0` says, said in the argv instead.
 *
 * `status` and `diff` both refresh the index as they read, which takes
 * `index.lock` — and a `claude` process running `git commit` in the same
 * directory at that moment fails with "index.lock exists". `gitEnv` turns that
 * off, but an environment does not survive the trip through ssh, so on a remote
 * worktree the only way to say it is here, where it travels with the command.
 * `worktree list` does not need it: it never touches the index.
 */
const NO_LOCKS = '--no-optional-locks';

/**
 * How the patch must be printed for `parseUnifiedDiff` to read it.
 *
 * `--src-prefix`/`--dst-prefix` are pinned because a user's
 * `diff.mnemonicPrefix` would otherwise make the paths `c/…` and `w/…`;
 * `--no-ext-diff` because a configured external diff driver would replace the
 * output wholesale; `--submodule=short` because `diff.submodule=log` would
 * print a commit log where the `Subproject commit` lines should be. Every one
 * of them is a setting a user may already have, and none of them is something
 * the parser could recover from.
 */
const PATCH_FORMAT = [
  '-U3', '--find-renames', '--no-color', '--no-ext-diff',
  '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short',
];

/**
 * git's name for the tree with nothing in it.
 *
 * The base for "everything uncommitted" is normally HEAD, but a repository
 * whose first commit has not happened yet has no HEAD to name. Diffing against
 * the empty tree says the true thing there — every tracked file is an addition
 * — where `git diff HEAD` would only say `fatal:`.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Enough worktrees for any rail; the cap is only there so the map cannot grow forever. */
const CACHED_WORKTREES = 32;

/** What is remembered for one worktree-and-base, and what makes it stale. */
interface CachedChanges {
  /** The HEAD sha and the status output it was computed from. */
  key: string;
  /** The commit the diff was actually taken against, so `diffFile` matches its row. */
  revision: string;
  result: DiffResult;
}

const UNCOMMITTED: DiffBase = { kind: 'uncommitted' };

/** A repository nothing is known about yet — no commits, no branch. */
const NO_BRANCH: StatusBranch = { head: null, branch: null, detached: false };

export class GitService {
  /**
   * The last `changedFiles` answer per worktree-and-base.
   *
   * Keyed on the HEAD sha and the `git status` output rather than on a clock,
   * because those two *are* the inputs: nothing can change what the diff says
   * without either moving HEAD or changing what status reports. A timer would
   * be wrong in both directions at once — still serving a stale list a second
   * after a session wrote a file, and re-reading an untouched tree every time
   * the user flips to the code side and back. Probing the key costs one cheap
   * command; it is the diff and the classification that the cache saves.
   */
  readonly #changed = new Map<string, CachedChanges>();

  /** One parsed `.gitattributes` per worktree, with the stat that would invalidate it. */
  readonly #attributes = new Map<string, { stamp: string; match: GeneratedAttributes | null }>();

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
    const { log } = this.deps;
    const result = await this.#git(projectPath, ['worktree', 'list', '--porcelain']);

    if (result.code === 0) {
      const worktrees = parseWorktreeList(result.stdout);
      log.debug(`[git] ${worktrees.length} worktree(s) in ${projectPath}`);
      return worktrees;
    }
    if (result.code === GIT_FATAL) {
      log.debug(`[git] ${projectPath} is not a git repository`);
      return [];
    }
    throw this.#failure(`worktree list in ${projectPath}`, result);
  }

  /**
   * Every path git has something to say about in this worktree: changed,
   * conflicted, or not yet tracked.
   *
   * The working tree only — nothing here knows about commits — so this is what
   * the sidebar's dirty marks and the conflict list are drawn from. Not a
   * repository is an empty list, for the same reason as `worktrees`.
   */
  async status(worktreePath: string): Promise<FileStatus[]> {
    const output = await this.#status(worktreePath);
    return output === null ? [] : parseStatus(output);
  }

  /**
   * Every file that differs from `base`, with its size and its classification
   * but without its lines.
   *
   * One `git diff --raw --numstat -z` for the whole tree: the raw half says
   * what happened to each path, the numstat half how many lines it cost, and
   * neither carries content. That is what makes the file list affordable on a
   * 212-file diff, and it is why every `FileDiff` here has an empty `hunks` —
   * `diffFile` fills them in for the one file someone opens.
   *
   * `base` is what the surface asked for; `DiffResult.base` is what it got.
   * They differ when the ref has been deleted or HEAD is detached, in which
   * case this falls back to uncommitted-only and reports having done so
   * (invariant 7: never guess a base and present its diff as the truth).
   *
   * Untracked files are reported separately, in `untracked`. git's diff does
   * not know about files git does not track, so nothing here can say how many
   * lines one holds; which of them belong on screen — the ones a session
   * created, not the rest of the working tree — is the surface's decision.
   */
  async changedFiles(worktreePath: string, base: DiffBase): Promise<DiffResult> {
    const output = await this.#status(worktreePath);
    if (output === null) {
      // No repository: nothing changed, and no base could have been resolved.
      return { base: UNCOMMITTED, requestedBase: base, files: [], untracked: [] };
    }

    const branch = parseStatusBranch(output);
    const place = cacheKey(worktreePath, base);
    const key = `${branch.head ?? ''}\0${output}`;
    const cached = this.#changed.get(place);
    if (cached?.key === key) return cached.result;

    const resolved = await this.#resolve(worktreePath, base, branch);
    const summary = await this.#git(worktreePath, [
      NO_LOCKS, 'diff', '--raw', '--numstat', '-z', '--find-renames', '--no-ext-diff',
      resolved.revision, '--',
    ]);
    if (summary.code !== 0) throw this.#failure(`diff in ${worktreePath}`, summary);

    const result: DiffResult = {
      base: resolved.base,
      requestedBase: base,
      files: summarise(summary.stdout, this.#generatedAttributes(worktreePath)),
      untracked: parseStatus(output).filter(file => file.status === '?'),
    };
    this.#remember(place, { key, revision: resolved.revision, result });
    return result;
  }

  /**
   * One file's hunks.
   *
   * Called when the user expands a file, and never before: this is the
   * expensive half. The pathspec keeps it to that file, so the cost is the file
   * and not the tree — and the old path is added to the pathspec when the file
   * list already knows this was a rename, so git still has both sides to pair.
   *
   * The base is the one that file's row was computed against, taken from the
   * cache when there is an entry: the hunks then agree with the diffstat beside
   * them even if a commit landed in between, which is worth more here than
   * being a second fresher.
   *
   * `whitespaceOnly` is decided here rather than in `changedFiles` because
   * deciding it costs a second diff — one per file, which is fine for the file
   * someone opened and absurd for all 212 of them.
   */
  async diffFile(worktreePath: string, base: DiffBase, relPath: string): Promise<FileDiff> {
    const rel = worktreeRelative(relPath);
    const cached = this.#changed.get(cacheKey(worktreePath, base));
    const revision = cached?.revision ?? (await this.#resolveFresh(worktreePath, base)).revision;
    const known = cached?.result.files.find(file => file.path === rel);

    // A rename is two paths, and the pathspec has to name both or git has
    // nothing to pair the surviving side with.
    const paths = known?.oldPath ? [rel, known.oldPath] : [rel];
    const patch = await this.#git(worktreePath, [
      NO_LOCKS, 'diff', ...PATCH_FORMAT, revision, '--', ...paths,
    ]);
    if (patch.code !== 0) throw this.#failure(`diff of ${rel} in ${worktreePath}`, patch);

    const [parsed] = parseUnifiedDiff(patch.stdout);
    // An empty patch means the file matches the base after all — a save that
    // undid itself, or a row the tree has moved past. The row survives with no
    // hunks rather than becoming an error.
    if (!parsed) return known ? { ...known, hunks: [] } : unchanged(rel);

    const file: FileDiff = {
      ...parsed,
      generated: known?.generated ?? isGenerated(rel, this.#generatedAttributes(worktreePath)),
    };
    // A pathspec is applied before rename detection reports itself, so a patch
    // limited to one file prints a rename as an ordinary modification of the
    // new path. The file list saw the whole tree and knows better, so its
    // identity for this row wins.
    if (known && file.status === 'M' && (known.status === 'R' || known.status === 'C')) {
      file.status = known.status;
      if (known.oldPath !== undefined) file.oldPath = known.oldPath;
      if (known.similarity !== undefined) file.similarity = known.similarity;
    }
    if (!file.binary && file.additions > 0 && file.additions === file.deletions) {
      file.whitespaceOnly = await this.#whitespaceOnly(worktreePath, revision, paths);
    }
    return file;
  }

  /**
   * The text of one file as of `ref` — what the deleted side of a diff looked
   * like, which is the only way to read a file that is no longer there.
   *
   * `<ref>:<path>` resolves the path from the repository root, and a worktree's
   * root is its own, so the relative path the surface already has is the right
   * one. A path that is not in that commit is a `fatal:` and is thrown with
   * git's own message; the surface prints it where the file would have been.
   */
  async fileAt(worktreePath: string, ref: string, relPath: string): Promise<string> {
    const rel = worktreeRelative(relPath);
    if (!ref) throw new Error('a ref is required to read a file at one');
    const result = await this.#git(worktreePath, ['show', `${ref}:${rel}`]);
    if (result.code === 0) return result.stdout;
    throw this.#failure(`show ${ref}:${rel} in ${worktreePath}`, result);
  }

  // ── Running git ──

  /**
   * Run git in this worktree, wherever it is.
   *
   * No cwd: `-C` is already in the argv, which is what lets the same command
   * run over ssh, where there is no cwd to set. The env only reaches a local
   * git — ssh does not forward it — which is why the lock flag also travels in
   * the argv; see `NO_LOCKS`.
   */
  async #git(worktreePath: string, args: readonly string[]): Promise<ExecResult> {
    const invocation = gitInvocation(worktreePath, args);
    return this.deps.runner.exec(invocation.file, invocation.args, {
      timeoutMs: isRemoteProjectPath(worktreePath) ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
      env: gitEnv({}),
    });
  }

  /** The failure to throw, with git's own words when it had any. */
  #failure(what: string, result: ExecResult): Error {
    const detail = result.stderr.trim() || `git exited with code ${result.code}`;
    this.deps.log.warn(`[git] ${what} failed:`, detail);
    return new Error(detail);
  }

  /**
   * `git status --porcelain=v2 -z --branch`, or null when there is no
   * repository here.
   *
   * `--branch` is asked for even when only the file list is wanted, because it
   * adds the HEAD sha and whether HEAD is detached to the same output — so one
   * command answers what changed, which commit that is against, and whether a
   * base can be resolved at all.
   */
  async #status(worktreePath: string): Promise<string | null> {
    const result = await this.#git(worktreePath, [
      NO_LOCKS, 'status', '--porcelain=v2', '-z', '--untracked-files=normal', '--branch',
    ]);
    if (result.code === 0) return result.stdout;
    if (result.code === GIT_FATAL) {
      this.deps.log.debug(`[git] ${worktreePath} is not a git repository`);
      return null;
    }
    throw this.#failure(`status in ${worktreePath}`, result);
  }

  /**
   * The base as a commit to diff against, and the base to report having used.
   *
   * Every failure lands on the same fallback — the working tree against HEAD —
   * because that one always works and never lies (invariant 7). A detached HEAD
   * takes `merge-base` down with it: the merge base of a HEAD that is not on a
   * branch is not "what this branch did", and offering its diff as if it were
   * is exactly the guess the invariant forbids.
   *
   * The fallback names HEAD by sha rather than by name, so the diff is taken
   * against precisely the commit the cache key was built from.
   */
  async #resolve(
    worktreePath: string, requested: DiffBase, branch: StatusBranch,
  ): Promise<{ base: DiffBase; revision: string }> {
    const fallback = { base: UNCOMMITTED, revision: branch.head ?? EMPTY_TREE };
    if (requested.kind === 'uncommitted') return fallback;

    if (requested.kind === 'merge-base') {
      if (branch.detached || branch.head === null) {
        this.deps.log.debug(`[git] no branch point for ${requested.ref}: HEAD is not on a branch`);
        return fallback;
      }
      const merged = await this.#git(worktreePath, ['merge-base', 'HEAD', requested.ref]);
      const sha = merged.stdout.trim();
      if (merged.code !== 0 || sha === '') {
        this.deps.log.debug(`[git] no merge base with ${requested.ref} in ${worktreePath}`);
        return fallback;
      }
      return { base: requested, revision: sha };
    }

    // `--quiet` so a ref that is simply gone is exit 1 and silence rather than
    // a `fatal:` on stderr; `^{commit}` so a tag or a tree cannot stand in for
    // one.
    const verified = await this.#git(
      worktreePath, ['rev-parse', '--verify', '--quiet', `${requested.ref}^{commit}`]);
    const sha = verified.stdout.trim();
    if (verified.code !== 0 || sha === '') {
      this.deps.log.debug(`[git] ${requested.ref} does not resolve in ${worktreePath}`);
      return fallback;
    }
    return { base: requested, revision: sha };
  }

  /** The base, resolved from a fresh status read — for a `diffFile` with no row to lean on. */
  async #resolveFresh(worktreePath: string, base: DiffBase): Promise<{ base: DiffBase; revision: string }> {
    const output = await this.#status(worktreePath);
    return this.#resolve(worktreePath, base, output === null ? NO_BRANCH : parseStatusBranch(output));
  }

  /**
   * Is every changed line in these paths a change to whitespace?
   *
   * Asked only of a file whose additions and deletions are equal, which is the
   * only shape a reformatting can take. git answers by leaving the file out of
   * a `-w` diff entirely; some versions instead report it with both counts
   * zero, so both readings count as yes.
   */
  async #whitespaceOnly(worktreePath: string, revision: string, paths: readonly string[]): Promise<boolean> {
    const result = await this.#git(worktreePath, [
      NO_LOCKS, 'diff', '-w', '--numstat', '-z', '--no-ext-diff', revision, '--', ...paths,
    ]);
    if (result.code !== 0) return false;
    const entries = parseNumstat(result.stdout);
    return entries.every(entry => !entry.binary && entry.additions === 0 && entry.deletions === 0);
  }

  /**
   * The worktree's `.gitattributes` as a `linguist-generated` matcher, or null
   * when there is nothing to read it with.
   *
   * Read through the filesystem port rather than through git, so it is the file
   * as it is now rather than as it was committed — and only for a local
   * worktree, since there is no far-side filesystem here. Cached against the
   * file's mtime and size, so editing it takes effect and leaving it alone
   * costs one `stat`.
   */
  #generatedAttributes(worktreePath: string): GeneratedAttributes | null {
    const { fs, log } = this.deps;
    if (!fs || isRemoteProjectPath(worktreePath)) return null;

    const file = fs.join(worktreePath, '.gitattributes');
    const stat = fs.stat(file);
    const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : '';
    const cached = this.#attributes.get(worktreePath);
    if (cached && cached.stamp === stamp) return cached.match;

    let match: GeneratedAttributes | null = null;
    if (stat) {
      try {
        match = parseGitattributesGenerated(fs.readText(file));
      } catch (err) {
        log.debug(`[git] ${file} could not be read:`, (err as Error).message);
      }
    }
    this.#attributes.set(worktreePath, { stamp, match });
    return match;
  }

  /** Keep the newest answer for this place, dropping the oldest when the map is full. */
  #remember(place: string, entry: CachedChanges): void {
    if (!this.#changed.has(place) && this.#changed.size >= CACHED_WORKTREES) {
      const oldest = this.#changed.keys().next().value;
      if (oldest !== undefined) this.#changed.delete(oldest);
    }
    this.#changed.set(place, entry);
  }
}

/** The `git <args>` command for this worktree, wherever it lives. */
function gitInvocation(worktreePath: string, args: readonly string[]): GitInvocation {
  if (!isRemoteProjectPath(worktreePath)) return localGit(worktreePath, args);

  const remote = parseRemoteProjectPath(worktreePath);
  // The renderer only ever hands back paths the app built, so this is a bug,
  // not a user error — but a bug that should name itself rather than be
  // mistaken for a folder with no repository.
  if (!remote) throw new Error(`not a valid remote project path: ${worktreePath}`);
  return remoteGit(remote, remoteCommandDir(remote.dir), args);
}

/**
 * The two sections of one `--raw --numstat` call, joined into the file list.
 *
 * Driven from the raw section, which is the one that knows what happened —
 * numstat can count a file that grew by forty lines but cannot tell that from a
 * file that is new. A numstat record with no raw counterpart is kept anyway, as
 * a modification: it should not happen, and losing a changed file is a worse
 * answer than mislabelling one.
 */
function summarise(stdout: string, attributes: GeneratedAttributes | null): FileDiff[] {
  const counts = new Map<string, NumstatEntry>();
  for (const entry of parseNumstat(stdout)) counts.set(entry.path, entry);

  const files: FileDiff[] = [];
  for (const raw of parseRawDiff(stdout)) {
    const count = counts.get(raw.path);
    counts.delete(raw.path);
    const file: FileDiff = {
      path: raw.path,
      status: raw.status,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      binary: count?.binary ?? false,
      generated: isGenerated(raw.path, attributes),
      whitespaceOnly: false,
      submodule: raw.oldMode === SUBMODULE_MODE || raw.newMode === SUBMODULE_MODE,
      hunks: [],
    };
    if (raw.oldPath !== undefined) file.oldPath = raw.oldPath;
    if (raw.similarity !== undefined) file.similarity = raw.similarity;
    // Two different modes, both real, is a chmod — which the hunks will not
    // mention, and a file that only gained the execute bit has none at all.
    if (raw.oldMode !== raw.newMode && raw.oldMode !== '000000' && raw.newMode !== '000000') {
      file.modeChange = { from: raw.oldMode, to: raw.newMode };
    }
    markTruncated(file);
    files.push(file);
  }

  for (const count of counts.values()) {
    const file: FileDiff = {
      path: count.path,
      status: 'M',
      additions: count.additions,
      deletions: count.deletions,
      binary: count.binary,
      generated: isGenerated(count.path, attributes),
      whitespaceOnly: false,
      submodule: false,
      hunks: [],
    };
    if (count.oldPath !== undefined) file.oldPath = count.oldPath;
    markTruncated(file);
    files.push(file);
  }

  return files;
}

/**
 * Why this file's hunks were not fetched, when there is a reason.
 *
 * Being generated comes first: a 12,000-line lockfile is both, and "this is
 * output" is the more useful thing to tell the reader than "this is long".
 */
function markTruncated(file: FileDiff): void {
  if (file.binary) return;
  if (file.generated) file.truncated = 'generated';
  else if (isOversized(file)) file.truncated = 'size';
}

/** One key per worktree-and-base, so a place holds one answer rather than a history of them. */
function cacheKey(worktreePath: string, base: DiffBase): string {
  return `${worktreePath}\0${base.kind === 'uncommitted' ? base.kind : `${base.kind}:${base.ref}`}`;
}

/** A row for a file that turned out not to differ from its base after all. */
function unchanged(path: string): FileDiff {
  return {
    path,
    status: 'M',
    additions: 0,
    deletions: 0,
    binary: false,
    generated: false,
    whitespaceOnly: false,
    submodule: false,
    hunks: [],
  };
}

/**
 * `relPath`, normalized to a path that cannot leave the worktree.
 *
 * Every path here arrives from a list the app itself produced, so a `..` in one
 * is a bug rather than a user's doing — but `<ref>:<path>` and a diff pathspec
 * both reach outside the worktree given the chance, and a reader for the whole
 * disk is not a thing to leave lying next to an ssh connection. Backslashes
 * count as separators too, so a Windows-shaped `..\..` cannot slip past on a
 * machine where `\` is one.
 */
function worktreeRelative(relPath: string): string {
  const parts = String(relPath ?? '').split(/[\\/]+/).filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) {
    throw new Error(`path leaves the worktree: ${relPath}`);
  }
  return parts.join('/');
}
