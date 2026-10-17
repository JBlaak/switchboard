/**
 * The words and pills the Session work page draws for a snapshot and its items.
 *
 * Pure, so it is tested in node with the slice; the components only lay out
 * what these answer.
 */
import type {
  Activity, FileDiff, GitHubAvailability, LineStats, SessionWorkItem, SessionWorkSnapshot, WorkAction,
} from '../../../domain/session-work/model';
import { availableActions, NOT_RUNNING_REASON, openThreadCount } from '../../../domain/session-work/actions';
import { shipSteps, type ShipStepState } from '../../../domain/session-work/ship';
import { MAX_AUTO_FIX_ATTEMPTS } from '../../../domain/session-work/auto-fix';

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
      if (!item.pushed) pills.push({ label: 'Not pushed', tone: 'amber' });
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

// ── Actions ──

/** One button in an item's action row. */
export interface ActionButton {
  /** The action it asks for, or `github` for Open on GitHub, which only links out. */
  readonly id: WorkAction | 'github';
  readonly label: string;
  readonly tone: 'primary' | 'warn' | 'plain';
  /** What it does, as its title while it can be pressed. */
  readonly hint: string;
  /** Why it cannot be pressed now, as its title; null when it can. */
  readonly disabled: string | null;
}

/** What the buttons depend on besides the item. */
export interface ActionState {
  readonly gh: GitHubAvailability;
  /** Is the session running? Nothing can be typed into it otherwise. */
  readonly running: boolean;
  /** An action asked of main and not answered yet, if any. */
  readonly pending: { readonly itemId: string; readonly action: WorkAction } | null;
}

const HINTS: Record<WorkAction, string> = {
  ship: 'Rebase if behind, wait for CI, merge, clean up',
  rebase: 'The branch is behind its base',
  'fix-ci': 'Hand the failing check to Claude',
  'fix-comments': 'Hand every open thread to Claude',
  'open-pr': 'Claude pushes the branch and opens a PR',
};

/** While its action is waiting or with Claude, a button says so instead. */
const WORKING_LABELS: Partial<Record<WorkAction, string>> = {
  ship: 'Shipping…',
  'fix-ci': 'Fixing CI…',
  'fix-comments': 'Fixing comments…',
  'open-pr': 'Opening PR…',
  rebase: 'Rebasing…',
};

/**
 * The item's action buttons, in the order they are drawn (A3, A5): what the
 * item offers, then Open on GitHub for a PR. A button whose action is queued
 * or with Claude says so and cannot be pressed again, and while the session
 * is not running none of them can.
 */
export function itemButtons(item: SessionWorkItem, state: ActionState): ActionButton[] {
  const buttons: ActionButton[] = availableActions(item, state.gh).map((action) => {
    const activity = item.kind === 'pr' || item.kind === 'branch' ? item.activity : null;
    const working = activity?.action === action && (activity.phase === 'queued' || activity.phase === 'sent');
    let disabled: string | null = null;
    if (working) disabled = activity!.phase === 'queued' ? 'Queued: sends when the session is idle' : 'Claude is on it';
    else if (!state.running) disabled = NOT_RUNNING_REASON;
    else if (state.pending?.itemId === item.id) disabled = 'Handing it to Claude…';
    return {
      id: action,
      label: working ? WORKING_LABELS[action] ?? actionLabel(item, action) : actionLabel(item, action),
      tone: action === 'ship' || action === 'open-pr' ? 'primary' : action === 'fix-ci' ? 'warn' : 'plain',
      hint: HINTS[action],
      disabled,
    };
  });
  if (item.kind === 'pr') {
    buttons.push({ id: 'github', label: 'Open on GitHub', tone: 'plain', hint: item.pr.url, disabled: null });
  }
  return buttons;
}

function actionLabel(item: SessionWorkItem, action: WorkAction): string {
  switch (action) {
    case 'ship': return 'Ship it';
    case 'rebase': return 'Rebase on origin/' + (item.kind === 'pr' && item.pr.baseRef ? item.pr.baseRef : 'main');
    case 'fix-ci': return 'Fix CI';
    case 'fix-comments': return `Fix comments (${item.kind === 'pr' ? openThreadCount(item.pr) : 0})`;
    case 'open-pr': return 'Open PR';
  }
}

/** The card above an item's diff while an action on it is waiting, with Claude, or given up. */
export interface ActivityCard {
  readonly tone: 'grey' | 'amber' | 'blue' | 'red';
  readonly title: string;
  readonly detail: string;
  /** The stored action, for Cancel; only a queued one can be. */
  readonly cancelId: string | null;
  /** Whether "View in terminal" is offered: something is happening there. */
  readonly viewInTerminal: boolean;
  /** Ship it's four steps; empty for every other action. */
  readonly steps: ReadonlyArray<{ readonly label: string; readonly state: ShipStepState }>;
  /** Lines listed under the head: each automatic attempt, when auto-fix gave up. */
  readonly lines?: readonly string[];
}

/** What an action does, in a few words, for the card's title. */
function actionPhrase(item: SessionWorkItem, action: WorkAction): string {
  const ref = item.kind === 'pr' ? ' #' + item.pr.number : '';
  switch (action) {
    case 'ship': return 'ship' + ref;
    case 'rebase': return 'rebase' + ref;
    case 'fix-ci': return 'fix CI on' + ref;
    case 'fix-comments': {
      const n = item.kind === 'pr' ? openThreadCount(item.pr) : 0;
      return `fix ${plural(n, 'review comment')}`;
    }
    case 'open-pr': return 'open a PR for ' + (item.kind === 'branch' ? item.location.branch : 'the branch');
  }
}

/**
 * The selected item's activity card (the States table): grey while it waits
 * for the session, amber while Claude works on it, blue with its steps for a
 * Ship it, red once Claude gave up. Null when nothing is going on.
 */
export function activityCard(item: SessionWorkItem, now: number): ActivityCard | null {
  const activity: Activity | null = item.kind === 'pr' || item.kind === 'branch' ? item.activity : null;
  if (!activity) return null;
  const phrase = actionPhrase(item, activity.action);
  const steps = activity.action === 'ship' && item.kind === 'pr'
    ? shipSteps(item.pr, activity).map(step => ({ label: step.label, state: step.state }))
    : [];
  const automatic = activity.action === 'fix-ci' && activity.origin === 'auto';
  const attemptOf = automatic && activity.attempt !== undefined
    ? ` · attempt ${activity.attempt} of ${MAX_AUTO_FIX_ATTEMPTS}`
    : '';
  switch (activity.phase) {
    case 'queued':
      return {
        tone: 'grey',
        title: 'Queued: ' + phrase + attemptOf,
        detail: 'Sends when the session finishes its current turn',
        cancelId: activity.id,
        viewInTerminal: false,
        steps: [],
      };
    case 'sent': {
      const since = activity.sentAt ? ' · ' + sentAgo(activity.sentAt, now) : '';
      if (activity.action === 'ship' && item.kind === 'pr') {
        return {
          tone: 'blue',
          title: 'Shipping #' + item.pr.number,
          detail: 'Claude is working through it in the session' + since,
          cancelId: null,
          viewInTerminal: true,
          steps,
        };
      }
      if (attemptOf) {
        return {
          tone: 'amber',
          title: 'Claude is fixing CI' + attemptOf,
          detail: (activity.checkName ? activity.checkName + ' failed · ' : '') + 'sent to the session' + since,
          cancelId: null,
          viewInTerminal: true,
          steps: [],
        };
      }
      return {
        tone: 'amber',
        title: 'Claude is on it: ' + phrase,
        detail: 'Sent to the session' + since,
        cancelId: null,
        viewInTerminal: true,
        steps: [],
      };
    }
    case 'gave-up':
      if (automatic && activity.attempts) {
        return {
          tone: 'red',
          title: `Still failing after ${plural(activity.attempts.length, 'automatic fix', 'automatic fixes')}`,
          detail: (activity.checkName ? activity.checkName + ' still fails. ' : '') + 'It needs you now: have a look, or try Fix CI yourself.',
          cancelId: null,
          viewInTerminal: true,
          steps: [],
          lines: activity.attempts.map((attempt) => `Attempt ${attempt.attempt} · failed on ${shortSha(attempt.failedOn)} · `
            + (attempt.pushed ? 'pushed ' + shortSha(attempt.pushed) : 'nothing pushed')),
        };
      }
      return {
        tone: 'red',
        title: 'Claude gave up: ' + phrase,
        detail: 'It needs you now. Have a look in the terminal, or try again.',
        cancelId: null,
        viewInTerminal: true,
        steps,
      };
    case 'done':
      return null;
  }
}

/** A commit as GitHub abbreviates it. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** "started 2m ago", from when the prompt was typed in. */
function sentAgo(sentAt: string, now: number): string {
  const at = Date.parse(sentAt);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'started just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `started ${minutes}m ago`;
  return `started ${Math.floor(minutes / 60)}h ago`;
}

/** The header's "Session busy · n queued" while actions wait for the session (A2); null when none do. */
export function queueLabel(snapshot: SessionWorkSnapshot): string | null {
  return snapshot.queued > 0 ? `Session busy · ${snapshot.queued} queued` : null;
}

// ── The diff ──

/** "3 files changed" over a diff, with its added and removed lines in all. */
export function diffSummary(files: readonly FileDiff[]): { label: string; stats: LineStats } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { label: plural(files.length, 'file') + ' changed', stats: { additions, deletions } };
}

/**
 * The pill beside a file's path: how it changed, unless it was only modified.
 * A new file in uncommitted changes that git does not track yet says so.
 */
export function fileStatusPill(file: FileDiff, untracked: boolean): Pill | null {
  switch (file.status) {
    case 'added': return untracked ? { label: 'Untracked', tone: 'amber' } : { label: 'New', tone: 'green' };
    case 'deleted': return { label: 'Deleted', tone: 'red' };
    case 'renamed': return { label: 'Renamed', tone: 'lavender' };
    case 'copied': return { label: 'Copied', tone: 'lavender' };
    case 'modified': return null;
  }
}

/** Why a file starts collapsed (D7), in words; null when it does not. */
export function collapsedText(file: FileDiff): string | null {
  switch (file.collapsedReason) {
    case 'lockfile': return 'Lock file';
    case 'generated': return 'Generated file';
    case 'large': return `Large diff · ${(file.additions + file.deletions).toLocaleString('en-US')} lines changed`;
    default: return null;
  }
}

/**
 * "N worktrees · M branches" the session worked in: every one its transcripts
 * name, not only the ones an item still lives in.
 */
export function footprintLine(snapshot: SessionWorkSnapshot): string {
  const { worktrees, branches } = snapshot.footprint;
  return `${plural(worktrees, 'worktree')} · ${plural(branches, 'branch', 'branches')}`;
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
