/**
 * Turning what is known about a session into the page's list of work items.
 *
 * Four sources each know part of the story: the transcripts know where the
 * session worked and which PRs it opened, git knows which branches have
 * commits and which worktrees have changes, and `gh` knows how each PR is
 * doing and which branch it came from. None of them alone says "this session
 * has these three things in flight", so this is where they are put together —
 * and where one piece of work that shows up in two sources becomes one item.
 */
import type { SessionPullRequest } from '../session/session';
import { issueFromBranch, standaloneIssues } from './issues';
import { locationKey } from './locations';
import type { Activity, DiffSource, FileChange, IssueRef, PullRequestStatus, WorkItem, WorkLocation } from './model';
import { needsYou } from './status';

/** What git says about one branch the session worked on that still exists locally. */
export interface BranchFacts {
  worktree: string;
  branch: string;
  /** The repository's default branch: never an item of its own (D5). */
  isDefault: boolean;
  /** Commits on the branch that `base` does not have. */
  ahead: number;
  /** What the branch's diff is taken against, e.g. `origin/main`. */
  base: string;
  /** Lines the branch adds and removes since its merge-base with `base`. */
  additions: number;
  deletions: number;
}

/** What `git status` says about one worktree the session worked in. */
export interface WorktreeChanges {
  worktree: string;
  /** The branch checked out there now. */
  branch: string;
  files: FileChange[];
  /** Lines the uncommitted changes add and remove, untracked files included. */
  additions: number;
  deletions: number;
}

/** Everything {@link deriveWorkItems} works from. */
export interface WorkFacts {
  /** Where the transcripts were written from (see `workLocations`). */
  locations: readonly WorkLocation[];
  /** From the transcript's `pr-link` lines, chronological. */
  pullRequests: readonly SessionPullRequest[];
  branches: readonly BranchFacts[];
  changes: readonly WorktreeChanges[];
  /** What `gh` said about each PR, matched by URL; null when `gh` is missing or signed out (D9). */
  github: readonly PullRequestStatus[] | null;
  /** Issues the conversation mentions (see `issueMentionsInTranscript`). */
  issueMentions: readonly IssueRef[];
  /** `owner/repo` of the session's repository, for the issue a branch is named after; '' when unknown. */
  repository: string;
  /** Each item's current action, by {@link workItemKey}. */
  activities?: ReadonlyMap<string, Activity>;
}

/**
 * A stable identity for an item, for keying activities, selection and React.
 *
 * A PR is its URL, which the transcript records and which does not change;
 * a branch or a dirty worktree is where it lives.
 */
export function workItemKey(item: WorkItem): string {
  switch (item.kind) {
    case 'pr': return 'pr:' + item.pr.url;
    case 'branch': return 'branch:' + locationKey(item.location.worktree, item.location.branch);
    case 'dirty': return 'dirty:' + locationKey(item.location.worktree, item.location.branch);
    case 'issue': return 'issue:' + item.issue.repository + '#' + item.issue.number;
  }
}

/** Merged and closed PRs: collapsed under Done (D5). */
export function isDone(item: WorkItem): boolean {
  return item.kind === 'pr' && (item.pr.state === 'merged' || item.pr.state === 'closed');
}

/**
 * The session's work items, in the order the page lists them.
 *
 * Open and draft PRs come first, the ones that need you before the rest and
 * otherwise newest first, because that is where the next move is. Then
 * branches still waiting for a PR, worktrees with uncommitted changes, the
 * issues nothing closes (mentioned in the conversation or named in a branch),
 * and last the PRs that are done. A PR `gh` has not described yet counts as
 * open: unknown is not finished.
 *
 * A branch that heads a PR is that PR's item, not a second one, and gives the
 * PR its location. Matching is by branch name, which is all `gh` says about the
 * head; without `gh` nothing can match, and the branch stays an item of its
 * own rather than vanishing. A worktree is dirty at most once — under the
 * branch it has checked out now — however many branches the session had it
 * on, and only worktrees and branches the transcripts name are looked at.
 */
export function deriveWorkItems(facts: WorkFacts): WorkItem[] {
  const activityOf = (key: string) => facts.activities?.get(key) ?? null;
  const locations = new Map<string, WorkLocation>();
  for (const location of facts.locations) {
    const key = locationKey(location.worktree, location.branch);
    if (!locations.has(key)) locations.set(key, location);
  }

  // PRs, one per URL, with whatever gh added.
  const github = new Map((facts.github ?? []).map((status) => [status.url, status]));
  const pullRequests = new Map<string, { pr: PullRequestStatus; order: number }>();
  facts.pullRequests.forEach((link, order) => {
    if (pullRequests.has(link.url)) return;
    const known = github.get(link.url);
    const pr: PullRequestStatus = known
      ? { ...known, number: link.number, url: link.url, repository: known.repository || link.repository }
      : { number: link.number, url: link.url, repository: link.repository, closes: [] };
    pullRequests.set(link.url, { pr, order });
  });

  // Local branches the session touched, and which PR (if any) each one heads.
  const branchFacts = new Map<string, BranchFacts>();
  for (const branch of facts.branches) {
    const key = locationKey(branch.worktree, branch.branch);
    if (locations.has(key) && !branchFacts.has(key)) branchFacts.set(key, branch);
  }
  const prByHead = new Map<string, PullRequestStatus>();
  for (const { pr } of pullRequests.values()) {
    if (pr.headRef && !prByHead.has(pr.headRef)) prByHead.set(pr.headRef, pr);
  }

  const prLocation = new Map<string, { location: WorkLocation; base: string }>();
  const branchItems: WorkItem[] = [];
  for (const [key, branch] of branchFacts) {
    if (branch.isDefault) continue;
    const location = locations.get(key)!;
    const pr = prByHead.get(branch.branch);
    if (pr) {
      // The main conversation's checkout of a branch beats a subagent's copy.
      const current = prLocation.get(pr.url);
      if (!current || (current.location.fromSubagent && !location.fromSubagent)) {
        prLocation.set(pr.url, { location, base: branch.base });
      }
      continue;
    }
    if (branch.ahead <= 0) continue;
    const item: WorkItem = {
      kind: 'branch',
      location,
      ahead: branch.ahead,
      diff: { kind: 'local', worktree: branch.worktree, base: branch.base, head: branch.branch },
      activity: null,
      additions: branch.additions,
      deletions: branch.deletions,
    };
    item.activity = activityOf(workItemKey(item));
    branchItems.push(item);
  }

  const openPrs: Array<{ item: WorkItem; order: number; needsYou: boolean }> = [];
  const donePrs: Array<{ item: WorkItem; order: number }> = [];
  for (const { pr, order } of pullRequests.values()) {
    const local = prLocation.get(pr.url) ?? null;
    const diff: DiffSource = local
      ? {
        kind: 'local',
        worktree: local.location.worktree,
        base: pr.baseRef ? 'origin/' + pr.baseRef : local.base,
        head: local.location.branch,
      }
      : { kind: 'pull-request', repository: pr.repository, number: pr.number };
    const item: WorkItem = { kind: 'pr', pr, location: local?.location ?? null, diff, activity: null };
    item.activity = activityOf(workItemKey(item));
    if (isDone(item)) donePrs.push({ item, order });
    else openPrs.push({ item, order, needsYou: needsYou(pr, item.activity) });
  }
  openPrs.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || b.order - a.order);
  donePrs.sort((a, b) => b.order - a.order);

  // Uncommitted changes, once per worktree the session was in.
  const touchedWorktrees = new Map<string, boolean>();
  for (const location of locations.values()) {
    const onlySubagents = touchedWorktrees.get(location.worktree) ?? true;
    touchedWorktrees.set(location.worktree, onlySubagents && location.fromSubagent);
  }
  const dirtyItems: WorkItem[] = [];
  const seenWorktrees = new Set<string>();
  for (const change of facts.changes) {
    if (change.files.length === 0 || seenWorktrees.has(change.worktree)) continue;
    const fromSubagent = touchedWorktrees.get(change.worktree);
    if (fromSubagent === undefined) continue;
    seenWorktrees.add(change.worktree);
    const known = locations.get(locationKey(change.worktree, change.branch));
    dirtyItems.push({
      kind: 'dirty',
      location: known ?? { worktree: change.worktree, branch: change.branch, fromSubagent },
      files: change.files,
      additions: change.additions,
      deletions: change.deletions,
    });
  }

  // Issues no PR closes, and that are not the session's own PRs by another name.
  const claimed: IssueRef[] = [];
  for (const { pr } of pullRequests.values()) {
    claimed.push(...pr.closes, { repository: pr.repository, number: pr.number });
  }
  const mentioned = [...facts.issueMentions];
  for (const location of locations.values()) {
    const issue = issueFromBranch(location.branch, facts.repository);
    if (issue) mentioned.push(issue);
  }
  const issueItems: WorkItem[] = standaloneIssues(mentioned, claimed)
    .map((issue) => ({ kind: 'issue', issue }));

  return [
    ...openPrs.map((entry) => entry.item),
    ...branchItems,
    ...dirtyItems,
    ...issueItems,
    ...donePrs.map((entry) => entry.item),
  ];
}
