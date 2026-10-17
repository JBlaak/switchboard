/**
 * The Plan tab's back end (#121): which plans a session works on, one plan by
 * its issue, and a project's plans for the picker.
 *
 * A session's plans are the parents of the issues it owns (W2, S1): the issues
 * its branches are named after, and the issues its PRs close. Mentions in the
 * conversation do not count. Next to them come the open plans of the session's
 * repository (W3), for when it owns none or to switch to another.
 *
 * The renderer polls every minute while the tab is on screen (W4) and more
 * than one view may ask at once, so every answer is kept for 30 seconds: a
 * second ask within that time, or one while the first is still out, does not
 * run `gh` again. A failed answer (null) is not kept, so the next ask tries
 * again.
 */
import { issueFromBranch } from '../../domain/session-work/issues';
import { isRemoteProjectPath } from '../../domain/project/remote-target';
import { gitHubRepository } from '../../domain/project/repo-url';
import { issueKeyString, type IssueKey, type Plan, type PlanSummary } from '../../domain/plan/model';
import type { Clock } from '../ports/clock';
import type { GitWorkspace } from '../ports/git-workspace';
import type { GitHubCli } from '../ports/github-cli';
import type { GitRemotes } from '../ports/git-remotes';
import type { TranscriptStore } from '../ports/transcript-store';

/** How long an answer is reused. */
export const PLAN_CACHE_MS = 30_000;

/** A session's plans (W2), and the repository's other open plans to pick from (W3). */
export interface SessionPlans {
  /** The plans the session's issues belong to, the most recently active first. */
  plans: Plan[];
  others: PlanSummary[];
}

/** Where a session's transcripts live and the directory it was started in. */
export interface PlanSessionTarget {
  /** The transcript folder; null when the session has none yet. */
  folder: string | null;
  projectPath: string;
}

export interface PlanServiceDeps {
  /** Where a session lives, or null when no session goes by that id. */
  locate(sessionId: string): PlanSessionTarget | null;
  transcripts: Pick<TranscriptStore, 'locations' | 'readSession'>;
  git: Pick<GitWorkspace, 'worktreeRoot'>;
  remotes: GitRemotes;
  github: Pick<GitHubCli, 'plan' | 'plansIn' | 'parentsOf' | 'closingIssues'>;
  clock: Clock;
}

interface Cached<T> {
  at: number;
  answer: Promise<T | null>;
}

export class PlanService {
  readonly #cache = new Map<string, Cached<unknown>>();

  constructor(private readonly deps: PlanServiceDeps) {}

  /**
   * The plans a session works on, and its repository's open plans. Null for a
   * session that is not in a GitHub repository, or when `gh` could not be asked.
   */
  sessionPlans(sessionId: string): Promise<SessionPlans | null> {
    return this.#cached('session:' + sessionId, () => this.#sessionPlans(sessionId));
  }

  /** One plan, by its issue (F2). Null when `gh` could not be asked or there is no such issue. */
  plan(repo: string, number: number): Promise<Plan | null> {
    return this.#cached(`plan:${repo}#${number}`, () => this.deps.github.plan(repo, number));
  }

  /**
   * A project's plans for the picker (F1): open ones, and closed ones too with
   * `closed` (F3). Null for a project that is not a GitHub repository, or when
   * `gh` could not be asked.
   */
  async projectPlans(projectPath: string, options: { closed: boolean }): Promise<PlanSummary[] | null> {
    const repository = await this.#repositoryOf(projectPath);
    return repository ? this.#plansIn(repository, options.closed === true) : null;
  }

  async #sessionPlans(sessionId: string): Promise<SessionPlans | null> {
    const target = this.deps.locate(sessionId);
    if (!target) return null;
    const repository = await this.#repositoryOf(target.projectPath);
    if (!repository) return null;

    const issues = await this.#sessionIssues(sessionId, target, repository);
    if (!issues) return null;
    const parents = issues.length > 0 ? await this.deps.github.parentsOf(issues) : [];
    if (!parents) return null;

    const [plans, others] = await Promise.all([
      Promise.all(parents.map((parent) => this.plan(parent.repository, parent.number))),
      this.#plansIn(repository, false),
    ]);
    if (!others) return null;
    const found = plans.filter((plan): plan is Plan => plan !== null);
    found.sort((a, b) => latestUpdate(b).localeCompare(latestUpdate(a)));
    return { plans: found, others };
  }

  /**
   * The issues a session owns (S1): the issues its branches are named after,
   * and the issues its PRs close, once each. Null when `gh` could not be asked.
   */
  async #sessionIssues(sessionId: string, target: PlanSessionTarget, repository: string): Promise<IssueKey[] | null> {
    const { transcripts, github } = this.deps;
    const owned = new Map<string, IssueKey>();
    const add = (issue: IssueKey) => owned.set(issueKeyString(issue), { repository: issue.repository, number: issue.number });
    if (!target.folder) return [];

    for (const location of transcripts.locations(target.folder, sessionId)) {
      const issue = issueFromBranch(location.branch, repository);
      if (issue) add(issue);
    }

    const pullRequests = transcripts.readSession(target.folder, sessionId, target.projectPath)?.pullRequests ?? [];
    const byRepository = new Map<string, number[]>();
    for (const pr of pullRequests) {
      const repo = pr.repository || repository;
      const numbers = byRepository.get(repo) ?? [];
      if (!numbers.includes(pr.number)) numbers.push(pr.number);
      byRepository.set(repo, numbers);
    }
    for (const [repo, numbers] of byRepository) {
      const closing = await github.closingIssues(repo, numbers);
      if (!closing) return null;
      for (const pr of closing) pr.closes.forEach(add);
    }
    return [...owned.values()];
  }

  #plansIn(repository: string, closed: boolean): Promise<PlanSummary[] | null> {
    return this.#cached(`plans:${repository}:${closed ? 'all' : 'open'}`, () => this.deps.github.plansIn(repository, { closed }));
  }

  /** `owner/repo` of the project's origin remote; null when it is not a GitHub repository. */
  async #repositoryOf(projectPath: string): Promise<string | null> {
    if (isRemoteProjectPath(projectPath)) return null;
    const root = await this.deps.git.worktreeRoot(projectPath);
    if (!root) return null;
    const origin = await this.deps.remotes.originUrl(root);
    return (origin && gitHubRepository(origin)) || null;
  }

  /** The answer kept under `key` while it is fresh; a null answer is dropped once it lands. */
  #cached<T>(key: string, ask: () => Promise<T | null>): Promise<T | null> {
    const now = this.deps.clock.now();
    const hit = this.#cache.get(key) as Cached<T> | undefined;
    if (hit && now - hit.at < PLAN_CACHE_MS) return hit.answer;

    const entry: Cached<T> = { at: now, answer: ask().catch(() => null) };
    this.#cache.set(key, entry);
    void entry.answer.then((answer) => {
      if (answer === null && this.#cache.get(key) === entry) this.#cache.delete(key);
    });
    // Drop what has gone stale, so the cache does not grow with every session asked about.
    for (const [other, cached] of this.#cache) {
      if (now - cached.at >= PLAN_CACHE_MS) this.#cache.delete(other);
    }
    return entry.answer;
  }
}

/** When anything in the plan last changed: the plan with the most recently updated issue comes first (W2). */
function latestUpdate(plan: Plan): string {
  return plan.issues.reduce((latest, issue) => (issue.updatedAt > latest ? issue.updatedAt : latest), '');
}
