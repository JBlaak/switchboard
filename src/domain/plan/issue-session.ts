/**
 * Starting a session on a plan's issue (A2, A3) and which session owns an
 * issue (S1): the rules, without git, GitHub or a terminal.
 *
 * The main process prepares the worktree (`IssueWorktreeResult`) and the
 * renderer starts Claude in it, because a session's row is the renderer's to
 * make. Which branch the worktree starts from is `startBase`; which session
 * owns an issue is `issueOwners`.
 */
import { issueKeyString, sameIssue, type IssueKey, type Plan, type PlanIssue, type PlanPullRequest } from './model';
import { issueFromBranch } from '../session-work/issues';

/** What the renderer hands main to prepare an issue's worktree. */
export interface IssueWorktreeRequest {
  /** The project to start in: any directory of the repository, a worktree of it included. */
  projectPath: string;
  issue: IssueKey;
  /** The plan the issue is in, as the renderer has it: its blockers and their PRs decide the base (A3). */
  plan: Plan;
}

/** A worktree made for an issue, with the prompt Claude starts with; or why there is none. */
export type IssueWorktreeResult =
  | {
    ok: true;
    worktreePath: string;
    branch: string;
    prompt: string;
    /** The blocker PR the branch is stacked on (A3). */
    stackedOn?: number;
    /** Something the renderer shows: it started, but not as asked (no blocker PR, a fetch that failed). */
    warning?: string;
  }
  | { ok: false; reason: string };

/** What `startIssueSession` answers (the contract's shape, plus the warning to show). */
export type IssueSessionStart = { ok: true; sessionId: string; warning?: string } | { ok: false; reason: string };

/**
 * Where an issue's worktree branches off (A3).
 *
 * - Every blocker closed (Ready): the default branch.
 * - A blocker still open with an open PR: that PR's head, the first such
 *   blocker in the issue's "Blocked by" order, its newest open PR.
 * - Blockers open and none has an open PR: the default branch, and the
 *   renderer is told which blockers it is starting ahead of.
 */
export type StartBase =
  | { kind: 'default'; openBlockers: IssueKey[] }
  | { kind: 'stacked'; blocker: IssueKey; pullRequest: PlanPullRequest };

export function startBase(plan: Plan, issue: IssueKey): StartBase {
  const known = [...plan.issues, ...plan.outside];
  const subject = plan.issues.find((candidate) => sameIssue(candidate, issue));
  const blockers = (subject?.blockedBy ?? [])
    .map((key) => known.find((candidate) => sameIssue(candidate, key)))
    .filter((blocker): blocker is PlanIssue => blocker !== undefined && blocker.state === 'open');

  for (const blocker of blockers) {
    const open = blocker.pullRequests
      .filter((pr) => pr.state === 'open' && pr.headRef)
      .sort((a, b) => b.number - a.number);
    if (open.length > 0) return { kind: 'stacked', blocker: { repository: blocker.repository, number: blocker.number }, pullRequest: open[0] };
  }
  return { kind: 'default', openBlockers: blockers.map(({ repository, number }) => ({ repository, number })) };
}

/** `#118` in the issue's own repository, `owner/repo#118` elsewhere. */
export function issueLabel(issue: IssueKey, repository: string): string {
  return issue.repository === repository ? '#' + issue.number : issueKeyString(issue);
}

/** A session as ownership sees it: the branches it worked on and the issues its PRs close. */
export interface IssueOwnerCandidate {
  sessionId: string;
  /** Epoch ms of its last activity: the most recent of two owners wins. */
  activeAt: number;
  /** Its branches, in `repository`. */
  branches: readonly string[];
  /** The issues its PRs close, by GitHub's closing references. */
  closes: readonly IssueKey[];
}

/**
 * `owner/repo#n` → the session that owns it (S1): one of its branches is
 * named after the issue (`issueFromBranch`), or one of its PRs closes it. What
 * the conversation mentions never counts, which is why it is not an input.
 * When two sessions own an issue, the most recently active one wins.
 */
export function issueOwners(candidates: readonly IssueOwnerCandidate[], repository: string): Record<string, string> {
  const owners = new Map<string, IssueOwnerCandidate>();
  const claim = (issue: IssueKey, candidate: IssueOwnerCandidate) => {
    const key = issueKeyString(issue);
    const current = owners.get(key);
    if (!current || candidate.activeAt > current.activeAt) owners.set(key, candidate);
  };
  for (const candidate of candidates) {
    for (const branch of candidate.branches) {
      const issue = issueFromBranch(branch, repository);
      if (issue) claim(issue, candidate);
    }
    for (const issue of candidate.closes) claim(issue, candidate);
  }
  const record: Record<string, string> = {};
  for (const [key, owner] of owners) record[key] = owner.sessionId;
  return record;
}
