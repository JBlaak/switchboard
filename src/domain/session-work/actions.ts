/**
 * Which actions a work item offers, and which of the actions on an item its
 * card shows.
 *
 * Every action is a prompt typed into the session's terminal (A1), so what an
 * item offers depends only on what is known about it: a PR offers Ship it and
 * whatever it needs (A3), a branch with no PR offers Open PR (A5), and
 * uncommitted changes offer Create a pull request. The page draws the buttons from this and
 * the main process refuses anything this does not allow, so the two cannot
 * drift apart.
 */
import type { Activity, CheckRun, GitHubAvailability, PullRequestStatus, WorkAction, WorkItem } from './model';

/** Ask for an action on an item (`SessionWorkItem.id`) of a session's open page. */
export interface ActionRequest {
  sessionId: string;
  itemId: string;
  action: WorkAction;
  /** For Fix comments: hand over only these review threads (Have Claude fix, Submit & have Claude fix). */
  threadIds?: string[];
}

/** Queued, with the id Cancel takes; or refused, with why. */
export type ActionResult = { ok: true; activityId: string } | { ok: false; reason: string };

/** Only a queued action can be cancelled; one typed in already cannot. */
export type CancelResult = { ok: true } | { ok: false; reason: string };

/** Why every action waits for the session: the prompt has nowhere to go. */
export const NOT_RUNNING_REASON = 'Start the session to hand this to Claude';

/** Review threads nobody has resolved yet: what Fix comments hands over. */
export function openThreadCount(pr: PullRequestStatus): number {
  return (pr.threads ?? []).filter((thread) => !thread.resolved).length;
}

/** The first failing check, as `gh` lists them: what Fix CI hands over. */
export function failingCheck(pr: PullRequestStatus): CheckRun | null {
  return (pr.checks ?? []).find((check) => check.state === 'failing') ?? null;
}

/**
 * The actions an item offers, in the order their buttons are drawn.
 *
 * Without `gh` nothing is offered (D9): every action ends on GitHub, and the
 * facts that decide them (behind, failing, open threads) are unknown. A
 * merged or closed PR has nothing left to do, and neither does one in another
 * repository: the session has no checkout of it to work in. Rebase only when the branch is
 * behind, Fix CI only when a check fails, Fix comments only when a thread is
 * open: an unknown field offers nothing rather than a button that might be a
 * no-op.
 */
export function availableActions(item: WorkItem, gh: GitHubAvailability): WorkAction[] {
  if (gh !== 'ok') return [];
  switch (item.kind) {
    case 'pr': {
      const { pr } = item;
      if (pr.state === 'merged' || pr.state === 'closed' || item.otherRepository) return [];
      const actions: WorkAction[] = ['ship'];
      if ((pr.behindBy ?? 0) > 0) actions.push('rebase');
      if (failingCheck(pr)) actions.push('fix-ci');
      if (openThreadCount(pr) > 0) actions.push('fix-comments');
      return actions;
    }
    case 'branch':
      return ['open-pr'];
    case 'dirty':
      return ['create-pr'];
    case 'issue':
      return [];
  }
}

/**
 * The action an item's card shows, out of every unfinished one on it (in the
 * order they were queued): the one Claude has, else the next one waiting, else
 * the last one Claude gave up on. A finished action shows nothing; the item's
 * own status says how it went.
 */
export function currentActivity(activities: readonly Activity[]): Activity | null {
  return activities.find((activity) => activity.phase === 'sent')
    ?? activities.find((activity) => activity.phase === 'queued')
    ?? [...activities].reverse().find((activity) => activity.phase === 'gave-up')
    ?? null;
}
