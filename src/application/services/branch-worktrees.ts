/**
 * The worktree a new session on a branch of its own starts in: an issue's
 * (A2, A3) or a task's (#244). The mechanics both share; the branch name, its
 * base and the prompt are the caller's.
 *
 * The worktree goes under the repository's `.claude/worktrees/<branch>`. When
 * the branch exists already, nothing is written unless the caller says what
 * to do with it (`existing`); the refusal says what is there, and which
 * session worked on it last.
 */
import { isRemoteProjectPath } from '../../domain/project/remote-target';
import type { ExistingBranch, ExistingBranchChoice } from '../../domain/project/branch-worktree';
import type { GitWorkspace, GitWorktrees } from '../ports/git-workspace';
import type { TranscriptStore } from '../ports/transcript-store';

/** Where a new session's worktree goes, under the repository's main checkout. */
export const WORKTREES_DIR = '/.claude/worktrees/';

/** A session that may have worked on a branch: every listed one, and every running one. */
export interface BranchSessionCandidate {
  sessionId: string;
  projectPath: string;
  /** Its transcript folder; null when it has none. */
  folder: string | null;
  /** Epoch ms of its last activity. */
  activeAt: number;
}

export interface BranchWorktreesDeps<S extends BranchSessionCandidate = BranchSessionCandidate> {
  sessions(): S[];
  transcripts: Pick<TranscriptStore, 'locations'>;
  git: Pick<GitWorkspace, 'currentBranch' | 'defaultBranch' | 'commitSha' | 'branchExists' | 'worktrees'> & GitWorktrees;
}

/**
 * Where a new branch starts when not from the default branch, and what to
 * tell the user about it. A null `base` starts from the default branch.
 */
export interface ChosenBase {
  base: string | null;
  warnings: string[];
}

export interface BranchWorktreeRequest {
  /** The repository's main checkout. */
  root: string;
  branch: string;
  existing?: ExistingBranchChoice;
  /**
   * The base of a new branch, asked only once the branch is free; without it,
   * or when it answers no base, the default branch.
   */
  base?: (defaultBranch: string) => Promise<ChosenBase>;
}

/**
 * The worktree, new (off a base) or `reused` (an existing branch continued);
 * or why there is none.
 */
export type BranchWorktreeResult =
  | { ok: true; worktreePath: string; branch: string; reused: boolean; warnings: string[] }
  | { ok: false; reason: string; existing?: ExistingBranch };

export class BranchWorktrees<S extends BranchSessionCandidate = BranchSessionCandidate> {
  /** A session's transcript branches, as of its last activity. */
  readonly #branches = new Map<string, { activeAt: number; branches: string[] }>();

  constructor(private readonly deps: BranchWorktreesDeps<S>) {}

  /** Make the worktree for `branch`, or say why not. */
  async prepare({ root, branch, existing, base }: BranchWorktreeRequest): Promise<BranchWorktreeResult> {
    const { git } = this.deps;
    const worktreePath = root.replace(/\/+$/, '') + WORKTREES_DIR + branch;
    if (await git.branchExists(root, branch)) {
      const found = await this.#existingBranch(root, branch);
      if (existing === 'reuse') {
        if (!found.worktreePath) {
          // A worktree whose directory has gone still holds its branch until it is pruned.
          await git.pruneWorktrees(root);
          const added = await git.checkoutWorktree(root, worktreePath, branch);
          if (!added.ok) return fail('Could not create the worktree: ' + added.reason);
        }
        return { ok: true, worktreePath: found.worktreePath ?? worktreePath, branch, reused: true, warnings: [] };
      }
      if (existing !== 'replace') return { ok: false, reason: `Branch ${branch} already exists`, existing: found };
      if (found.main) return fail(`Branch ${branch} is checked out in the main checkout, which is never deleted`);
      if (found.worktreePath) {
        const removed = await git.removeWorktree(root, found.worktreePath, { force: true });
        if (!removed.ok) return fail('Could not delete the worktree: ' + removed.reason);
      }
      await git.pruneWorktrees(root);
      const deleted = await git.deleteBranch(root, branch);
      if (!deleted.ok) return fail(`Could not delete branch ${branch}: ` + deleted.reason);
    }

    const defaultBranch = await git.defaultBranch(root);
    const chosen = base ? await base(defaultBranch) : { base: null, warnings: [] };
    const warnings = [...chosen.warnings];
    let start = chosen.base;
    if (!start) {
      const fetched = await git.fetchBranch(root, defaultBranch);
      if (await git.commitSha(root, 'origin/' + defaultBranch)) start = 'origin/' + defaultBranch;
      else if (await git.commitSha(root, defaultBranch)) start = defaultBranch;
      else return fail(`Could not find the default branch ${defaultBranch}` + (fetched.ok ? '' : `: ${fetched.reason}`));
      if (!fetched.ok) warnings.push(`Could not fetch ${defaultBranch} (${fetched.reason}); started from the last one fetched.`);
    }

    const added = await git.addWorktree(root, worktreePath, branch, start);
    if (!added.ok) return fail('Could not create the worktree: ' + added.reason);
    return { ok: true, worktreePath, branch, reused: false, warnings };
  }

  /**
   * The branches its transcripts were written on; a session with none yet
   * (just started) is on the branch its directory has checked out.
   */
  async branchesOf(session: S): Promise<string[]> {
    const known = this.#branches.get(session.sessionId);
    if (known && known.activeAt === session.activeAt && known.branches.length > 0) return known.branches;
    const written = session.folder ? this.deps.transcripts.locations(session.folder, session.sessionId) : [];
    let branches = [...new Set(written.map((location) => location.branch).filter(Boolean))];
    if (branches.length === 0) {
      const current = await this.deps.git.currentBranch(session.projectPath);
      branches = current ? [current] : [];
    }
    this.#branches.set(session.sessionId, { activeAt: session.activeAt, branches });
    return branches;
  }

  /**
   * Where an existing branch is checked out, what is on it, and the session
   * that worked there last: one in its worktree, else one whose transcripts
   * were written on the branch.
   */
  async #existingBranch(root: string, branch: string): Promise<ExistingBranch> {
    const checkout = (await this.deps.git.worktrees(root)).find((worktree) => worktree.branch === branch) ?? null;
    const local = this.deps.sessions().filter((session) => !isRemoteProjectPath(session.projectPath));
    const newest = (sessions: S[]) =>
      sessions.reduce<S | null>((best, session) => (!best || session.activeAt > best.activeAt ? session : best), null);

    let session = checkout && !checkout.main
      ? newest(local.filter((candidate) => isUnder(candidate.projectPath, checkout.path)))
      : null;
    if (!session) {
      const onBranch: S[] = [];
      for (const candidate of local) {
        if (!isUnder(candidate.projectPath, root)) continue;
        if ((await this.branchesOf(candidate)).includes(branch)) onBranch.push(candidate);
      }
      session = newest(onBranch);
    }
    return {
      branch,
      worktreePath: checkout?.path ?? null,
      main: checkout?.main ?? false,
      changedFiles: checkout?.changedFiles ?? 0,
      ahead: checkout?.ahead ?? 0,
      sessionId: session?.sessionId ?? null,
    };
  }
}

/** `path` is `dir` or a directory under it. */
function isUnder(path: string, dir: string): boolean {
  const base = dir.replace(/\/+$/, '');
  return path === base || path.startsWith(base + '/');
}

function fail(reason: string): BranchWorktreeResult {
  return { ok: false, reason };
}
