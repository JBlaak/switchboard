/**
 * The words and pills the Session work page draws for a snapshot and its items.
 *
 * Pure, so it is tested in node with the slice; the components only lay out
 * what these answer.
 */
import type { GitHubAvailability, LineStats, SessionWorkItem, SessionWorkSnapshot } from '../../../domain/session-work/model';

/** The pastel fill and matching ink a pill is drawn in. */
export type PillTone = 'green' | 'red' | 'amber' | 'grey' | 'lavender';

export interface Pill {
  readonly label: string;
  readonly tone: PillTone;
}

/** The small-caps word above an item's title. */
export function itemKind(item: SessionWorkItem): string {
  switch (item.kind) {
    case 'pr': return 'PR';
    case 'branch': return 'Branch';
    case 'dirty': return 'Uncommitted';
    case 'issue': return 'Issue';
  }
}

/** The mono reference beside the kind: `#52`, "no PR", or the branch. */
export function itemRef(item: SessionWorkItem): string {
  switch (item.kind) {
    case 'pr': return '#' + item.pr.number;
    case 'branch': return 'no PR';
    case 'dirty': return item.location.branch;
    case 'issue': return '#' + item.issue.number;
  }
}

/** The item's title, falling back to what is known when `gh` said nothing. */
export function itemTitle(item: SessionWorkItem): string {
  switch (item.kind) {
    case 'pr': return item.pr.title || item.pr.headRef || item.location?.branch || 'Pull request #' + item.pr.number;
    case 'branch': return item.location.branch;
    case 'dirty': return 'Uncommitted changes in ' + lastSegment(item.location.worktree);
    case 'issue': return 'title' in item.issue ? item.issue.title : 'Issue #' + item.issue.number;
  }
}

/**
 * The status pills, most urgent first: CI, then the PR's state, then how far
 * behind its base it is. An unknown field draws nothing, never "fine".
 */
export function itemPills(item: SessionWorkItem): Pill[] {
  const pills: Pill[] = [];
  switch (item.kind) {
    case 'pr': {
      const { pr } = item;
      const checks = pr.checks ?? [];
      if (checks.some(check => check.state === 'failing')) pills.push({ label: 'CI failing', tone: 'red' });
      else if (checks.some(check => check.state === 'pending')) pills.push({ label: 'CI running', tone: 'amber' });
      else if (checks.some(check => check.state === 'passing')) pills.push({ label: 'CI passing', tone: 'green' });
      if (pr.state === 'draft') pills.push({ label: 'Draft', tone: 'grey' });
      if (pr.state === 'merged') pills.push({ label: 'Merged', tone: 'lavender' });
      if (pr.state === 'closed') pills.push({ label: 'Closed', tone: 'grey' });
      if (pr.behindBy && pr.behindBy > 0 && pr.state !== 'merged' && pr.state !== 'closed') {
        pills.push({ label: `${pr.behindBy} behind ${pr.baseRef || 'main'}`, tone: 'amber' });
      }
      break;
    }
    case 'branch':
      pills.push({ label: plural(item.ahead, 'commit') + ' ahead', tone: 'grey' });
      break;
    case 'dirty':
      pills.push({ label: plural(item.files.length, 'file'), tone: 'grey' });
      break;
    case 'issue':
      if ('state' in item.issue) {
        pills.push(item.issue.state === 'open' ? { label: 'Open', tone: 'green' } : { label: 'Closed', tone: 'grey' });
      }
      break;
  }
  return pills;
}

/**
 * The lines an item adds and removes, for the list's `+a −d`; null when that
 * is not known (a PR `gh` has not described) or there is nothing to count.
 */
export function itemLineStats(item: SessionWorkItem): LineStats | null {
  switch (item.kind) {
    case 'pr':
      return item.pr.additions === undefined || item.pr.deletions === undefined
        ? null
        : { additions: item.pr.additions, deletions: item.pr.deletions };
    case 'branch':
    case 'dirty':
      return { additions: item.additions, deletions: item.deletions };
    case 'issue':
      return null;
  }
}

/** `head → base` for the detail, or just the branch when there is no base. */
export function itemBranchLine(item: SessionWorkItem): string | null {
  switch (item.kind) {
    case 'pr': {
      const head = item.location?.branch || item.pr.headRef;
      if (!head) return null;
      return item.pr.baseRef ? `${head} → ${item.pr.baseRef}` : head;
    }
    case 'branch':
      return item.diff.kind === 'local' ? `${item.location.branch} → ${item.diff.base}` : item.location.branch;
    case 'dirty':
      return item.location.branch;
    case 'issue':
      return null;
  }
}

/** The issues a PR closes, each with its page. */
export function closedIssues(item: SessionWorkItem, repository: string): Array<{ label: string; url: string | null }> {
  if (item.kind !== 'pr') return [];
  return item.pr.closes.map((issue) => {
    const repo = issue.repository || item.pr.repository || repository;
    const label = issue.repository && issue.repository !== repository ? `${issue.repository}#${issue.number}` : '#' + issue.number;
    return { label, url: repo ? `https://github.com/${repo}/issues/${issue.number}` : null };
  });
}

/** Where an item links out to on GitHub, if anywhere. */
export function itemUrl(item: SessionWorkItem, repository: string): string | null {
  if (item.kind === 'pr') return item.pr.url;
  if (item.kind === 'issue') {
    if ('url' in item.issue) return item.issue.url;
    const repo = item.issue.repository || repository;
    return repo ? `https://github.com/${repo}/issues/${item.issue.number}` : null;
  }
  return null;
}

/**
 * The line where the diff will go (#75), saying what changed as far as the
 * snapshot knows.
 */
export function itemSummary(item: SessionWorkItem): string {
  switch (item.kind) {
    case 'pr': return item.location ? `Changes on ${item.location.branch}` : 'Changes from GitHub';
    case 'branch': return plural(item.ahead, 'commit') + ' not in a pull request yet';
    case 'dirty': return plural(item.files.length, 'file') + ' changed';
    case 'issue': return '';
  }
}

/** "N worktrees · M branches" the session's items live in. */
export function footprintLine(snapshot: SessionWorkSnapshot): string {
  const worktrees = new Set<string>();
  const branches = new Set<string>();
  for (const item of snapshot.items) {
    if (item.kind === 'issue') continue;
    const location = item.location;
    if (location) {
      worktrees.add(location.worktree);
      branches.add(location.branch);
    } else if (item.kind === 'pr' && item.pr.headRef) {
      branches.add(item.pr.headRef);
    }
  }
  return `${plural(worktrees.size, 'worktree')} · ${plural(branches.size, 'branch', 'branches')}`;
}

/** "updated 4s ago", from the snapshot's time and the page's clock. */
export function updatedAgo(updatedAt: string, now: number): string {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  return `updated ${Math.floor(minutes / 60)}h ago`;
}

/** The banner shown once on the page when `gh` cannot be asked (D9); null when it can. */
export function githubBanner(gh: GitHubAvailability): string | null {
  switch (gh) {
    case 'ok': return null;
    case 'missing': return 'Install and sign in to the GitHub CLI (`gh`) to see PR status and CI.';
    case 'unauthenticated': return 'Run `gh auth login` in a terminal to see PR status and CI.';
  }
}

/** "3 agents working". */
export function agentsLabel(count: number): string {
  return `${count} ${count === 1 ? 'agent' : 'agents'} working`;
}

function plural(count: number, one: string, many = one + 's'): string {
  return `${count} ${count === 1 ? one : many}`;
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}
