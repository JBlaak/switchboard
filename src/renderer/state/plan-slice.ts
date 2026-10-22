/**
 * The plan view on screen (#121): where its plans come from, what main last
 * answered, which plan is chosen, and the issue hovered and selected.
 *
 * One plan view is on screen at a time: the Session work page's Plan tab, or
 * (#128) the Plan view without a session in the main area. Each home opens it
 * under its own `owner`, so one home closing never closes the other's.
 *
 * Where the plans come from is a `PlanSource`: a session's plans (W2), or one
 * plan by its issue (F2). The view is polled while it is open (W4, see
 * `ui/session-work/plan/install-plan`); a poll that fails keeps the last answer
 * on screen rather than blanking it.
 */
import type { IssueKey, Plan, PlanSummary } from '../../domain/plan/model';
import type { IssueSessionStart } from '../../domain/plan/issue-session';
import type { IdRecord } from './records';
import { hasEntry, withEntry } from './records';
import { issueKeyString, sameIssue } from '../../domain/plan/model';
import { layOutPlan } from '../../domain/plan/layout';
import { shouldCelebrate } from '../../domain/plan/celebrate';
import type { Celebration } from '../../domain/plan/celebrate';
import type { RendererEvent } from './events';

/** What `sessionPlans` answers (see `SessionPlans` in the plan service). */
export interface SessionPlansAnswer {
  readonly plans: readonly Plan[];
  readonly others: readonly PlanSummary[];
}

/** Where a plan view's plans come from. */
export type PlanSource =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'plan'; readonly repository: string; readonly number: number };

export interface PlanViewState {
  /** Which home opened the view: `session-work:<sessionId>`, or #128's. */
  readonly owner: string;
  readonly source: PlanSource;
  /** The source picked away from, for the way back; null when this is where the view opened. */
  readonly from: PlanSource | null;
  /** `loading` until the first answer for this source; a failed poll after that keeps `loaded`. */
  readonly phase: 'loading' | 'loaded' | 'failed';
  /** The last answer; a plan source answers as one plan and no others. */
  readonly answer: SessionPlansAnswer | null;
  /** The plan picked in the switcher; null is the default, the first (W2). */
  readonly chosen: IssueKey | null;
  readonly hovered: IssueKey | null;
  /** The issue whose detail is open; null when the panel is closed. */
  readonly selected: IssueKey | null;
  /** `owner/repo#n` → the session that owns it (S1), refreshed with every load. */
  readonly owners: IdRecord<string>;
  /** Start session on the selected issue (A2, A3): confirming, on its way, or answered. */
  readonly start: PlanStart | null;
}

/** Where Start session on an issue is. A Locked issue asks first, saying what it stacks on (A3). */
export type PlanStart =
  | { readonly issue: IssueKey; readonly phase: 'confirm' | 'starting' }
  | { readonly issue: IssueKey; readonly phase: 'answered'; readonly result: IssueSessionStart };

export interface PlanState {
  readonly view: PlanViewState | null;
  /**
   * `owner/repo#n` → the level last seen for that plan (A4); null once it was
   * seen cleared. Kept across restarts by `plan/levels-seen`.
   */
  readonly levelsSeen: IdRecord<number | null>;
  /** A level-up or a cleared plan to play, until the view has played it (A4). */
  readonly celebration: PlanCelebration | null;
  /**
   * Start level (A1): confirming, on its way, or answered. Its session starts
   * in the background, so the view stays and shows the answer inline; kept
   * outside the view so a view closed meanwhile still finds it when it is back.
   */
  readonly levelStart: PlanLevelStart | null;
}

/** A celebration to play: which plan, what for, and the issues that just turned Ready. */
export interface PlanCelebration {
  /** Counts up, so a view tells one celebration from the next. */
  readonly id: number;
  readonly plan: IssueKey;
  readonly celebration: Exclude<Celebration, { kind: 'none' }>;
  /** How many levels the plan has, for Patch's line. */
  readonly levels: number;
  /** The new current level's Ready issues, which animate in. */
  readonly arriving: readonly IssueKey[];
}

/** Start level on a plan's current level (A1). */
export type PlanLevelStart =
  | {
    readonly plan: IssueKey; readonly level: number; readonly issues: readonly IssueKey[];
    readonly phase: 'confirm' | 'starting';
  }
  | {
    readonly plan: IssueKey; readonly level: number; readonly issues: readonly IssueKey[];
    readonly phase: 'answered'; readonly started: number;
    readonly failed: readonly { readonly issue: IssueKey; readonly reason: string }[];
  };

export const initialPlanState: PlanState = { view: null, levelsSeen: {}, celebration: null, levelStart: null };

/** A stable string for a source, to tell an answer for it from one for another. */
export function planSourceKey(source: PlanSource): string {
  return source.kind === 'session' ? 'session:' + source.sessionId : 'plan:' + source.repository + '#' + source.number;
}

export function planReducer(state: PlanState, event: RendererEvent): PlanState {
  const viewed = reduceView(state, event);
  // Every plan the view shows is sighted: on each load and poll, and when the switcher picks it (A4).
  const sighted = viewed !== state && (event.type === 'planLoaded' || event.type === 'planChosen') ? sight(viewed) : viewed;
  return reduceLevels(sighted, event);
}

/**
 * Record the level of the plan on screen, and queue a celebration when it
 * went up or cleared since it was last seen (A4).
 */
function sight(state: PlanState): PlanState {
  const plan = state.view ? chosenPlan(state.view) : null;
  if (!plan) return state;
  const layout = layOutPlan(plan);
  const planKey = issueKeyString(plan);
  const first = !hasEntry(state.levelsSeen, planKey);
  const celebration = shouldCelebrate(state.levelsSeen[planKey] ?? null, layout.current, first);
  const levelsSeen = withEntry(state.levelsSeen, planKey, layout.current);
  if (celebration.kind === 'none') return levelsSeen === state.levelsSeen ? state : { ...state, levelsSeen };
  const arriving = celebration.kind === 'level-up'
    ? (layout.levels[celebration.level - 1] ?? []).filter(issue => layout.stateOf(issue) === 'ready').map(key)
    : [];
  return {
    ...state, levelsSeen,
    celebration: { id: (state.celebration?.id ?? 0) + 1, plan: key(plan), celebration, levels: layout.levels.length, arriving },
  };
}

function reduceLevels(state: PlanState, event: RendererEvent): PlanState {
  switch (event.type) {
    // What was seen before this run; anything seen since it started wins.
    case 'planLevelsSeenRestored':
      return Object.keys(event.seen).length ? { ...state, levelsSeen: { ...event.seen, ...state.levelsSeen } } : state;

    case 'planCelebrationPlayed':
      return state.celebration?.id === event.id ? { ...state, celebration: null } : state;

    case 'planLevelStartAsked':
      if (state.levelStart?.phase === 'starting' || !event.issues.length) return state;
      return {
        ...state,
        levelStart: { plan: key(event.plan), level: event.level, issues: event.issues.map(key), phase: 'confirm' },
      };

    case 'planLevelStartConfirmed':
      return state.levelStart?.phase === 'confirm' ? { ...state, levelStart: { ...state.levelStart, phase: 'starting' } } : state;

    case 'planLevelStartCancelled':
      return state.levelStart && state.levelStart.phase !== 'starting' ? { ...state, levelStart: null } : state;

    case 'planLevelStartAnswered': {
      const asked = state.levelStart;
      if (asked?.phase !== 'starting') return state;
      return {
        ...state,
        levelStart: {
          plan: asked.plan, level: asked.level, issues: asked.issues, phase: 'answered',
          started: event.started, failed: event.failed.map(({ issue, reason }) => ({ issue: key(issue), reason })),
        },
      };
    }

    default:
      return state;
  }
}

function reduceView(state: PlanState, event: RendererEvent): PlanState {
  const { view } = state;
  switch (event.type) {
    case 'planViewOpened': {
      if (view && view.owner === event.owner && planSourceKey(view.source) === planSourceKey(event.source)) return state;
      return { ...state, view: freshView(event.owner, event.source, null) };
    }

    case 'planViewClosed':
      return view?.owner === event.owner ? { ...state, view: null } : state;

    // Picked from the list of others, or back to where the view opened.
    case 'planSourcePicked': {
      if (!view || view.owner !== event.owner) return state;
      const key = planSourceKey(event.source);
      if (planSourceKey(view.source) === key) return state;
      const back = view.from && planSourceKey(view.from) === key;
      return { ...state, view: freshView(view.owner, event.source, back ? null : view.source) };
    }

    case 'planLoaded': {
      if (!view || view.owner !== event.owner || planSourceKey(view.source) !== event.sourceKey) return state;
      if (event.answer === null) {
        return view.answer ? state : { ...state, view: { ...view, phase: 'failed' } };
      }
      const answer = event.answer;
      const plans = answer.plans;
      const chosen = view.chosen && plans.some(plan => sameIssue(plan, view.chosen!)) ? view.chosen : null;
      const plan = chosen ? plans.find(p => sameIssue(p, chosen)) : plans[0];
      const inPlan = (issue: IssueKey | null) => !!issue && !!plan?.issues.some(i => sameIssue(i, issue));
      return {
        ...state,
        view: {
          ...view, phase: 'loaded', answer, chosen,
          hovered: inPlan(view.hovered) ? view.hovered : null,
          selected: inPlan(view.selected) ? view.selected : null,
        },
      };
    }

    case 'planOwnersLoaded': {
      if (!view || view.owner !== event.owner) return state;
      const same = Object.keys(view.owners).length === Object.keys(event.owners).length
        && Object.entries(event.owners).every(([issue, id]) => view.owners[issue] === id);
      return same ? state : { ...state, view: { ...view, owners: event.owners } };
    }

    case 'planStartAsked': {
      if (!view || !view.selected || !sameIssue(view.selected, event.issue)) return state;
      if (view.start && view.start.phase === 'starting') return state;
      return { ...state, view: { ...view, start: { issue: key(event.issue), phase: event.confirm ? 'confirm' : 'starting' } } };
    }

    case 'planStartCancelled':
      return view?.start?.phase === 'confirm' ? { ...state, view: { ...view, start: null } } : state;

    case 'planStartAnswered': {
      if (!view?.start || !sameIssue(view.start.issue, event.issue)) return state;
      return { ...state, view: { ...view, start: { issue: view.start.issue, phase: 'answered', result: event.result } } };
    }

    case 'planChosen': {
      if (!view?.answer) return state;
      if (!view.answer.plans.some(plan => sameIssue(plan, event.plan))) return state;
      const current = chosenPlan(view);
      if (current && sameIssue(current, event.plan)) return state;
      return { ...state, view: { ...view, chosen: key(event.plan), hovered: null, selected: null, start: null } };
    }

    case 'planIssueHovered': {
      if (!view) return state;
      if (sameOrBothNull(view.hovered, event.issue)) return state;
      return { ...state, view: { ...view, hovered: event.issue ? key(event.issue) : null } };
    }

    case 'planIssueSelected': {
      if (!view) return state;
      if (sameOrBothNull(view.selected, event.issue)) return state;
      if (event.issue && !chosenPlan(view)?.issues.some(i => sameIssue(i, event.issue!))) return state;
      // Another issue's start is no longer on screen; one on its way still answers to it.
      const start = view.start && view.start.phase !== 'starting' ? null : view.start;
      return { ...state, view: { ...view, selected: event.issue ? key(event.issue) : null, start } };
    }

    default:
      return state;
  }
}

/** A re-keyed session keeps its Plan tab. */
export function rekeyPlan(state: PlanState, oldId: string, newId: string): PlanState {
  const { view } = state;
  if (oldId === newId || !view) return state;
  const moveSource = (source: PlanSource | null): PlanSource | null =>
    source?.kind === 'session' && source.sessionId === oldId ? { kind: 'session', sessionId: newId } : source;
  const owner = view.owner === 'session-work:' + oldId ? 'session-work:' + newId : view.owner;
  const source = moveSource(view.source)!;
  const from = moveSource(view.from);
  if (owner === view.owner && source === view.source && from === view.from) return state;
  return { ...state, view: { ...view, owner, source, from } };
}

// ── Derived ──

/** The plan the view shows: the chosen one, or the first (W2). Null before an answer, or with none. */
export function chosenPlan(view: PlanViewState): Plan | null {
  const plans = view.answer?.plans ?? [];
  if (view.chosen) {
    const found = plans.find(plan => sameIssue(plan, view.chosen!));
    if (found) return found;
  }
  return plans[0] ?? null;
}

/**
 * The issue ↑ (-1) or ↓ (1) moves to from `current`, in level order (D4):
 * the first one when nothing is selected, null at either end.
 */
export function steppedIssue(order: readonly IssueKey[], current: IssueKey | null, direction: 1 | -1): IssueKey | null {
  if (!order.length) return null;
  const at = current ? order.findIndex(issue => sameIssue(issue, current)) : -1;
  if (at === -1) return order[0];
  const next = at + direction;
  return next >= 0 && next < order.length ? order[next] : null;
}

/**
 * The levels seen, as `plan/levels-seen` stored them; anything unreadable is
 * dropped, which only costs a plan its next celebration.
 */
export function storedLevelsSeen(raw: string | null): IdRecord<number | null> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const seen: Record<string, number | null> = {};
  for (const [planKey, level] of Object.entries(parsed)) {
    if (level === null || (typeof level === 'number' && Number.isInteger(level) && level > 0)) seen[planKey] = level;
  }
  return seen;
}

function freshView(owner: string, source: PlanSource, from: PlanSource | null): PlanViewState {
  return {
    owner, source, from, phase: 'loading', answer: null, chosen: null, hovered: null, selected: null, owners: {}, start: null,
  };
}

function key(issue: IssueKey): IssueKey {
  return { repository: issue.repository, number: issue.number };
}

function sameOrBothNull(a: IssueKey | null, b: IssueKey | null): boolean {
  return a === null || b === null ? a === b : issueKeyString(a) === issueKeyString(b);
}
