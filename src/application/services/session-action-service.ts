/**
 * Handing a work item to Claude: the actions on the Session work page, and
 * each session's queue of them.
 *
 * Every action is a prompt typed into the session's own terminal (A1). The
 * prompt is rendered when the action is asked for, from what the page knows
 * about the item then, and stored; it is typed in once the session is at its
 * prompt, and the action is done once the session has been busy with it and
 * come back to its prompt again. Asked for while Claude is mid-turn, it waits
 * (A2). Each session has one first-in-first-out queue, and only one action of
 * it is with Claude at a time, so two prompts never land in one turn.
 *
 * The queue is stored: a queued action survives a restart and is typed in
 * once its session is running and idle again. Nothing is ever sent to a
 * session that is not running; asking for an action on one is refused.
 *
 * What an action is doing shows on the page as its item's `Activity`, so every
 * change of phase tells the page (`activitiesChanged`).
 */
import {
  availableActions, currentActivity, failingCheck, NOT_RUNNING_REASON, type ActionResult, type CancelResult,
} from '../../domain/session-work/actions';
import { promptThreadIds, renderPrompt, type PromptRequest } from '../../domain/session-work/prompts';
import { threadsToFix } from '../../domain/session-work/review';
import type {
  Activity, GitHubAvailability, SessionWorkItem, WorkAction,
} from '../../domain/session-work/model';
import type { ActivityDetails, ActivityStore, StoredAction } from '../ports/activity-store';
import type { Clock } from '../ports/clock';
import type { Disposable } from '../ports/git-workspace';
import type { GitHubCli } from '../ports/github-cli';
import type { IdGenerator } from '../ports/ids';
import type { Logger } from '../ports/logger';
import type { SessionPrompter } from '../ports/session-prompter';

/** How much of a failing check's log the Fix CI prompt carries. */
export const LOG_TAIL_LINES = 40;

/** How much an automatic Fix CI carries: Claude reads it with nobody there to add more (W2). */
export const AUTO_FIX_LOG_TAIL_LINES = 80;

export type { ActionResult, CancelResult };

/** What the page knows that a prompt needs, for the session whose page is open. */
export interface ActionContext {
  repository: string;
  /** The worktree root the session was started in: where the base branch is pulled after Ship it. */
  mainCheckout: string;
  gh: GitHubAvailability;
}

/**
 * An item and its context handed in by whoever asks, instead of looked up on
 * the open page: the CI watch asks for a Fix CI with no page open.
 */
export interface ResolvedRequest {
  item: SessionWorkItem;
  context: ActionContext;
  /** Fix CI: the failing check to hand over, rather than the first one. */
  checkName?: string;
  /** Fix CI: which automatic attempt this is, 1-based. */
  attempt?: number;
}

/** How an action is asked for, beyond the item and the action. */
export interface RequestOptions {
  /** The item and its context, when the caller has them without the open page. */
  resolved?: ResolvedRequest;
  /** Fix comments: hand over only these review threads. */
  threadIds?: readonly string[];
}

/** What a gave-up card shows: the check, and each attempt with what Claude pushed. */
export type GaveUpDetails = Required<Pick<ActivityDetails, 'checkName' | 'attempts'>>;

/** The Session work page, as far as the actions need it. */
export interface WorkPageSource {
  /** An item of the session's open page; null when the page is not open for it, or the item is gone. */
  item(sessionId: string, itemId: string): SessionWorkItem | null;
  context(sessionId: string): ActionContext | null;
  /** An activity of this session changed. */
  activitiesChanged(sessionId: string): void;
}

/** One session's actions, as the page draws them. */
export interface SessionActivities {
  /** Each item's current action, by item id. */
  byItem: ReadonlyMap<string, Activity>;
  /** How many are waiting for the session to go idle. */
  queued: number;
  /** A Ship it is waiting or with Claude: the page polls GitHub faster. */
  shipping: boolean;
  /** The review threads a waiting or sent Fix comments covers, by item id: "Claude is on it". */
  fixingThreads?: ReadonlyMap<string, readonly string[]>;
}

export interface SessionActionServiceDeps {
  prompter: SessionPrompter;
  store: ActivityStore;
  github: Pick<GitHubCli, 'checkLogTail'>;
  ids: IdGenerator;
  clock: Clock;
  log: Logger;
}

export class SessionActionService {
  /** Every unfinished action, in the order they were queued. */
  readonly #actions: StoredAction[] = [];
  /** Idle listeners, one per session id a queue is stored under. */
  readonly #listening = new Map<string, Disposable>();
  #page: WorkPageSource | null = null;
  /** Others that follow the actions' phases (the CI watch's sidebar dots). */
  readonly #followers: Array<(sessionId: string) => void> = [];

  constructor(private readonly deps: SessionActionServiceDeps) {
    const now = this.#now();
    for (const action of deps.store.unfinished()) {
      // A sent action was with a session that ended when the app did: there is
      // nothing left to wait for, and what Claude finished shows on the item.
      if (action.phase === 'sent') {
        deps.store.update(action.id, { phase: 'done', doneAt: now });
        continue;
      }
      this.#actions.push(action);
    }
    for (const sessionId of new Set(this.#actions.filter(isQueued).map((action) => action.sessionId))) {
      this.#listen(sessionId);
    }
  }

  /** The page the actions are asked from. Set once, after both exist. */
  attach(page: WorkPageSource): void {
    this.#page = page;
  }

  /** Hear every change of an action's phase, as the page does. */
  follow(fn: (sessionId: string) => void): void {
    this.#followers.push(fn);
  }

  /**
   * Hand an item of the session's open page to Claude: render its prompt,
   * queue it, and type it in now if the session is idle.
   *
   * `options.resolved` hands the item and its context in instead, for a
   * caller that has them without the page (the CI watch's auto-fix);
   * `options.threadIds` has a Fix comments hand over only those threads
   * (Have Claude fix, Submit & have Claude fix).
   */
  async request(
    sessionId: string, itemId: string, action: WorkAction, origin: Activity['origin'] = 'manual',
    options: RequestOptions = {},
  ): Promise<ActionResult> {
    const { prompter } = this.deps;
    if (!prompter.runningId(sessionId)) return { ok: false, reason: NOT_RUNNING_REASON };
    const page = this.#page;
    const { resolved, threadIds } = options;
    const item = resolved?.item ?? page?.item(sessionId, itemId) ?? null;
    const context = resolved?.context ?? page?.context(sessionId) ?? null;
    if (!item || !context) return { ok: false, reason: 'This item is no longer on the page' };
    if (!availableActions(item, context.gh).includes(action)) {
      return { ok: false, reason: 'This item has nothing for that action to do' };
    }
    const same = this.#forSession(sessionId).filter((existing) =>
      existing.itemKey === itemId && existing.action === action && (existing.phase === 'queued' || existing.phase === 'sent'));
    // Fixing named threads is refused only when every one of them is handed over already.
    const busy = threadIds && action === 'fix-comments'
      ? (threadIds.every((id) => same.some((existing) => promptThreadIds(existing.prompt).includes(id))) ? same[0] : undefined)
      : same[0];
    if (busy) return { ok: false, reason: busy.phase === 'queued' ? 'Already queued' : 'Claude is already on it' };

    const request = await this.#promptRequest(item, action, context, options);
    if (!request) return { ok: false, reason: 'This item has nothing for that action to do' };
    // The session may have ended while the CI log was fetched.
    if (!prompter.runningId(sessionId)) return { ok: false, reason: NOT_RUNNING_REASON };

    const stored: StoredAction = {
      id: this.deps.ids.newId(),
      sessionId,
      repository: context.repository,
      itemKey: itemId,
      action,
      origin,
      phase: 'queued',
      prompt: renderPrompt(request),
      queuedAt: this.#now(),
      sentAt: null,
      doneAt: null,
      details: request.action === 'fix-ci' ? fixCiDetails(request.checkName, request.automaticAttempt) : null,
    };
    this.deps.store.add(stored);
    this.#actions.push(stored);
    this.#listen(sessionId);
    this.#changed(sessionId);
    this.#pump(sessionId);
    return { ok: true, activityId: stored.id };
  }

  /** Take a queued action out of its queue. One already typed in cannot be taken back. */
  cancel(activityId: string): CancelResult {
    const index = this.#actions.findIndex((action) => action.id === activityId);
    if (index === -1) return { ok: false, reason: 'Nothing is queued by that id' };
    const action = this.#actions[index];
    if (action.phase !== 'queued') return { ok: false, reason: 'It was already handed to Claude' };
    this.#actions.splice(index, 1);
    this.deps.store.remove(action.id);
    this.#unlistenIfIdle(action.sessionId);
    this.#changed(action.sessionId);
    return { ok: true };
  }

  /** Is this action still waiting for the session, or with Claude? */
  isInFlight(activityId: string): boolean {
    const action = this.#actions.find((candidate) => candidate.id === activityId);
    return action !== undefined && (action.phase === 'queued' || action.phase === 'sent');
  }

  /**
   * Auto-fix ran out of attempts on an item's check (W3): show it as given up,
   * red, until the check goes green or the PR is done. Nothing is typed in.
   */
  giveUp(sessionId: string, itemKey: string, repository: string, details: GaveUpDetails): void {
    const stored: StoredAction = {
      id: this.deps.ids.newId(),
      sessionId,
      repository,
      itemKey,
      action: 'fix-ci',
      origin: 'auto',
      phase: 'gave-up',
      prompt: '',
      queuedAt: this.#now(),
      sentAt: null,
      doneAt: null,
      details,
    };
    this.deps.store.add(stored);
    this.#actions.push(stored);
    this.#changed(sessionId);
  }

  /**
   * The check auto-fix gave up on is green again, or the PR is done: the item
   * no longer needs you. Without `checkName`, every give-up on the item ends.
   */
  settleGaveUp(sessionId: string, itemKey: string, checkName?: string): void {
    const now = this.#now();
    let settled = false;
    for (const action of this.#forSession(sessionId)) {
      if (action.phase !== 'gave-up' || action.itemKey !== itemKey) continue;
      if (checkName !== undefined && action.details?.checkName !== checkName) continue;
      this.#actions.splice(this.#actions.indexOf(action), 1);
      this.deps.store.update(action.id, { phase: 'done', doneAt: now });
      settled = true;
    }
    if (settled) this.#changed(sessionId);
  }

  /** One session's actions for its page, under any id it has gone by. */
  forSession(sessionId: string): SessionActivities {
    const actions = this.#forSession(sessionId);
    const byKey = new Map<string, Activity[]>();
    for (const action of actions) {
      const list = byKey.get(action.itemKey) ?? [];
      list.push(toActivity(action));
      byKey.set(action.itemKey, list);
    }
    const byItem = new Map<string, Activity>();
    for (const [key, list] of byKey) {
      const current = currentActivity(list);
      if (current) byItem.set(key, current);
    }
    return {
      byItem,
      queued: actions.filter(isQueued).length,
      shipping: actions.some((action) => action.action === 'ship' && (action.phase === 'queued' || action.phase === 'sent')),
      fixingThreads: fixingThreads(actions),
    };
  }

  // ── The queue ──

  /** Type the next queued action in, when the session is idle and has nothing else with Claude. */
  #pump(sessionId: string): void {
    const { prompter } = this.deps;
    if (!prompter.runningId(sessionId) || prompter.isBusy(sessionId)) return;
    const actions = this.#forSession(sessionId);
    if (actions.some((action) => action.phase === 'sent')) return;
    const next = actions.find(isQueued);
    if (!next) return;

    next.phase = 'sent';
    next.sentAt = this.#now();
    this.deps.store.update(next.id, { phase: 'sent', sentAt: next.sentAt });
    this.deps.log.info(`[session-work] typing ${next.action} into ${sessionId}`);
    prompter.send(sessionId, next.prompt);
    this.#changed(sessionId);
  }

  /**
   * The session came to its prompt. An action typed in before that has been
   * through a turn (an idle only follows a busy, or a first start, and nothing
   * is typed into a session that has not started), so it is done; then the
   * next one goes in.
   */
  #idle(sessionId: string): void {
    const now = this.#now();
    let finished = false;
    for (const action of this.#forSession(sessionId)) {
      if (action.phase !== 'sent') continue;
      this.#actions.splice(this.#actions.indexOf(action), 1);
      this.deps.store.update(action.id, { phase: 'done', doneAt: now });
      finished = true;
    }
    if (finished) this.#changed(sessionId);
    this.#pump(sessionId);
    this.#unlistenIfIdle(sessionId);
  }

  /**
   * The session's process ended. What was typed in will never be finished by
   * that turn, so it is done now rather than left amber until a restart (which
   * would do the same). What is still queued waits for the session to run again.
   */
  #exited(sessionId: string): void {
    const now = this.#now();
    let finished = false;
    for (const action of this.#forSession(sessionId)) {
      if (action.phase !== 'sent') continue;
      this.#actions.splice(this.#actions.indexOf(action), 1);
      this.deps.store.update(action.id, { phase: 'done', doneAt: now });
      finished = true;
    }
    if (finished) this.#changed(sessionId);
    this.#unlistenIfIdle(sessionId);
  }

  /**
   * Hear the session's idles and its exit, once per session: a queue stored
   * under an id the session has since moved on from is heard through that old
   * id, which the prompter still matches.
   */
  #listen(sessionId: string): void {
    for (const id of this.#listening.keys()) {
      if (this.#sameSession(id, sessionId)) return;
    }
    const idle = this.deps.prompter.onIdle(sessionId, () => this.#idle(sessionId));
    const exit = this.deps.prompter.onExit(sessionId, () => this.#exited(sessionId));
    this.#listening.set(sessionId, { dispose: () => { idle.dispose(); exit.dispose(); } });
  }

  /** Stop listening for a session that has nothing left waiting or with Claude. */
  #unlistenIfIdle(sessionId: string): void {
    for (const [id, listener] of this.#listening) {
      if (!this.#sameSession(id, sessionId)) continue;
      if (this.#forSession(id).some((action) => action.phase === 'queued' || action.phase === 'sent')) continue;
      listener.dispose();
      this.#listening.delete(id);
    }
  }

  /** This session's unfinished actions, in queue order, whichever of its ids each was stored under. */
  #forSession(sessionId: string): StoredAction[] {
    return this.#actions.filter((action) => this.#sameSession(action.sessionId, sessionId));
  }

  /** Do two ids name one session? They do when equal, or when the running session answers to both. */
  #sameSession(a: string, b: string): boolean {
    if (a === b) return true;
    const current = this.deps.prompter.runningId(a);
    return current !== null && current === this.deps.prompter.runningId(b);
  }

  #changed(sessionId: string): void {
    this.#page?.activitiesChanged(sessionId);
    for (const fn of this.#followers) fn(sessionId);
  }

  #now(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }

  // ── Prompts ──

  /** What the item's prompt needs, from the page's facts; null when the item cannot take the action. */
  async #promptRequest(
    item: SessionWorkItem, action: WorkAction, context: ActionContext, { resolved, threadIds }: RequestOptions = {},
  ): Promise<PromptRequest | null> {
    if (item.kind === 'branch') {
      if (action !== 'open-pr') return null;
      return {
        action: 'open-pr',
        branch: item.location.branch,
        worktree: item.location.worktree,
        base: item.diff.kind === 'local' ? item.diff.base.replace(/^origin\//, '') : 'main',
      };
    }
    if (item.kind === 'dirty') {
      if (action !== 'create-pr') return null;
      return { action: 'create-pr', branch: item.location.branch, worktree: item.location.worktree };
    }
    if (item.kind !== 'pr') return null;

    const { pr } = item;
    const worktree = item.location?.worktree ?? context.mainCheckout;
    const base = pr.baseRef || 'main';
    switch (action) {
      case 'ship':
        return {
          action: 'ship', number: pr.number, url: pr.url, base, method: pr.mergeMethod ?? 'merge',
          worktree, mainCheckout: context.mainCheckout,
        };
      case 'rebase':
        return { action: 'rebase', number: pr.number, headRef: pr.headRef || item.location?.branch || '', base };
      case 'fix-ci': {
        const named = resolved?.checkName;
        const check = named
          ? (pr.checks ?? []).find((candidate) => candidate.name === named && candidate.state === 'failing') ?? null
          : failingCheck(pr);
        if (!check) return null;
        const repository = pr.repository || context.repository;
        const automatic = resolved?.attempt;
        const lines = automatic === undefined ? LOG_TAIL_LINES : AUTO_FIX_LOG_TAIL_LINES;
        const log = check.url && repository ? await this.deps.github.checkLogTail(repository, check.url, lines) : null;
        return {
          action: 'fix-ci', number: pr.number, url: pr.url, checkName: check.name, sha: pr.headSha ?? 'the head commit',
          logTail: log ?? '(no log available; read it with gh run view)', worktree,
          ...(automatic === undefined ? {} : { automaticAttempt: automatic }),
        };
      }
      case 'fix-comments': {
        const threads = threadsToFix(pr, threadIds);
        if (threads.length === 0) return null;
        return { action: 'fix-comments', number: pr.number, url: pr.url, threads, worktree };
      }
      case 'open-pr':
      case 'create-pr':
        return null;
    }
  }
}

function isQueued(action: StoredAction): boolean {
  return action.phase === 'queued';
}

function toActivity(action: StoredAction): Activity {
  const activity: Activity = {
    id: action.id,
    action: action.action,
    phase: action.phase,
    origin: action.origin,
    queuedAt: action.queuedAt,
  };
  if (action.sentAt) activity.sentAt = action.sentAt;
  if (action.action === 'fix-comments') activity.threadIds = promptThreadIds(action.prompt);
  const details = action.details;
  if (details?.attempt !== undefined) activity.attempt = details.attempt;
  if (details?.checkName !== undefined) activity.checkName = details.checkName;
  if (details?.attempts !== undefined) activity.attempts = details.attempts;
  return activity;
}

function fixCiDetails(checkName: string, attempt: number | undefined): ActivityDetails {
  return attempt === undefined ? { checkName } : { checkName, attempt };
}

/** The threads each item's waiting or sent Fix comments cover. */
function fixingThreads(actions: readonly StoredAction[]): Map<string, string[]> {
  const byItem = new Map<string, string[]>();
  for (const action of actions) {
    if (action.action !== 'fix-comments' || (action.phase !== 'queued' && action.phase !== 'sent')) continue;
    const ids = byItem.get(action.itemKey) ?? [];
    for (const id of promptThreadIds(action.prompt)) if (!ids.includes(id)) ids.push(id);
    byItem.set(action.itemKey, ids);
  }
  return byItem;
}
