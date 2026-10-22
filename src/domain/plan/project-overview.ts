/**
 * The project page's Plans & issues and Pull requests sections (#167): a
 * repository's issues grouped under their plans, so a plan takes one row
 * instead of a page of sub-issues, with the rest listed as loose issues and
 * each open PR tied to the issues it closes and to their plan.
 *
 * The inputs are minimal structural shapes rather than the GitHub port's own
 * types, so whatever the port reads can be handed in as it is: `groupOverview`
 * is generic over the issue and PR types and gives the caller's objects back,
 * extra fields (labels, checks, review state) included.
 */
import { layOutPlan } from './layout';
import { issueKeyString, type IssueKey, type NodeState, type Plan, type PlanIssue } from './model';

/** An open issue of the repository, as the overview needs it. */
export interface OverviewIssue {
  number: number;
  title: string;
  updatedAt: string;
  /** The issue this one is a sub-issue of, by number in the same repository. */
  parent: number | null;
  /** How many sub-issues it has, open or closed. More than none makes it a plan. */
  subIssueCount: number;
}

/** An open pull request of the repository, as the overview needs it. */
export interface OverviewPullRequest {
  number: number;
  /** The issues it closes, by GitHub's closing references, by number in the same repository. */
  closes: readonly number[];
}

/** A plan read in full, with what its summary knows that `Plan` does not. */
export interface OverviewPlanSource {
  plan: Plan;
  state: 'open' | 'closed';
  updatedAt: string;
}

/** Which issues have a session, and which sessions are running. */
export interface OverviewSessions {
  /** `owner/repo#n` → the session that owns it, as `issueOwners` answers. */
  owners: Readonly<Record<string, string>>;
  /** The ids of the sessions running now. */
  running: ReadonlySet<string>;
}

export interface OverviewInput<I extends OverviewIssue, P extends OverviewPullRequest> {
  /** `owner/repo`: the repository the issue and PR numbers belong to. */
  repository: string;
  plans: readonly OverviewPlanSource[];
  issues: readonly I[];
  pullRequests: readonly P[];
  sessions: OverviewSessions;
}

/**
 * The one status an issue row shows on its right, by precedence: a running
 * session, else what it waits on, else its PR. `null` when none applies.
 */
export type IssueRowStatus<P> =
  | { kind: 'running'; sessionId: string }
  | { kind: 'waiting'; on: IssueKey[] }
  | { kind: 'pull-request'; pullRequest: P }
  | null;

/** What every issue row knows, in a plan or loose. */
export interface IssueRowFacts<P> {
  /** The session that owns the issue, running or not. */
  session: string | null;
  /** The newest open PR that closes it. */
  pullRequest: P | null;
  status: IssueRowStatus<P>;
  /** Open, not waiting on an open issue and owned by no session: Start session is offered. */
  startable: boolean;
}

/** An issue under a plan. */
export interface PlanIssueRow<P> extends IssueRowFacts<P> {
  issue: IssueKey & { title: string; state: 'open' | 'closed' };
  /** 1-based; 0 while the plan is not levelled. */
  level: number;
  segment: NodeState;
}

/** A plan's row and the issues it expands to. */
export interface OverviewPlan<P> {
  plan: IssueKey & { title: string };
  state: 'open' | 'closed';
  /** The latest `updatedAt` of the plan and its issues. */
  lastActivity: string;
  /** False for an issue with sub-issues whose plan was not read: its open sub-issues, unlevelled. */
  levelled: boolean;
  /** Level order, closed issues last. */
  issues: PlanIssueRow<P>[];
  progress: {
    closed: number;
    total: number;
    /** 1-based; null when the plan is cleared or not levelled. */
    current: number | null;
    levels: number;
    /** One per issue, in level order (closed ones not moved last), for the segmented bar. */
    segments: NodeState[];
  };
  /** A session owning the plan or one of its issues is running. */
  running: boolean;
  /** The open PRs that close any of its issues, each once, newest first. */
  pullRequests: P[];
}

/** An open issue that is in no plan and is not one. */
export interface LooseIssueRow<I, P> extends IssueRowFacts<P> {
  issue: I;
}

export interface OverviewPullRequestRow<P> {
  pullRequest: P;
  /** The issues it closes. */
  closes: IssueKey[];
  /** The plan the first of those belongs to, for the "in #n" chip. */
  plan: IssueKey | null;
}

export interface ProjectOverviewGroups<I, P> {
  plans: OverviewPlan<P>[];
  loose: LooseIssueRow<I, P>[];
  pullRequests: OverviewPullRequestRow<P>[];
}

const newestFirst = (a: string, b: string) => b.localeCompare(a);

/**
 * Groups a repository's open issues and PRs under its plans.
 *
 * - An issue under a plan, or with a parent at all, is never loose: every
 *   parent has sub-issues, so it is a plan, even when its plan was not read.
 * - An open issue with sub-issues that no read plan covers becomes a plan of
 *   its own, unlevelled, holding its open sub-issues by number.
 * - Plans: open before closed, then those with a running session, then by last
 *   activity. Loose issues: by `updatedAt`, newest first.
 */
export function groupOverview<I extends OverviewIssue, P extends OverviewPullRequest>(
  input: OverviewInput<I, P>,
): ProjectOverviewGroups<I, P> {
  const { repository, sessions } = input;
  const keyOf = (number: number): IssueKey => ({ repository, number });
  const owner = (issue: IssueKey): string | null => sessions.owners[issueKeyString(issue)] ?? null;
  const isRunning = (sessionId: string | null): sessionId is string => sessionId !== null && sessions.running.has(sessionId);

  // The newest open PR per issue, and each PR's issues.
  const prFor = new Map<string, P>();
  for (const pr of [...input.pullRequests].sort((a, b) => b.number - a.number)) {
    for (const number of pr.closes) {
      const key = issueKeyString(keyOf(number));
      if (!prFor.has(key)) prFor.set(key, pr);
    }
  }

  const facts = (issue: IssueKey, open: boolean, waitsOn: IssueKey[]): IssueRowFacts<P> => {
    const session = owner(issue);
    const pullRequest = prFor.get(issueKeyString(issue)) ?? null;
    const status: IssueRowStatus<P> = isRunning(session) ? { kind: 'running', sessionId: session }
      : open && waitsOn.length > 0 ? { kind: 'waiting', on: waitsOn }
      : pullRequest ? { kind: 'pull-request', pullRequest }
      : null;
    return { session, pullRequest, status, startable: open && waitsOn.length === 0 && session === null };
  };

  /** `owner/repo#n` of every issue that belongs to a plan or is one → that plan. */
  const planOf = new Map<string, IssueKey>();
  const plans: OverviewPlan<P>[] = [];

  for (const source of input.plans) {
    const { plan } = source;
    const planKey: IssueKey = { repository: plan.repository, number: plan.number };
    const layout = layOutPlan(plan);
    const known = new Map<string, PlanIssue>();
    for (const issue of [...plan.outside, ...plan.issues]) known.set(issueKeyString(issue), issue);
    const byKey = new Map(plan.issues.map((issue) => [issueKeyString(issue), issue]));
    const levelOrder = layout.levels.flat().map((key) => byKey.get(issueKeyString(key))!);

    const rows = levelOrder.map((issue): PlanIssueRow<P> => {
      const open = issue.state === 'open';
      const waitsOn = issue.blockedBy
        .filter((blocker) => issueKeyString(blocker) !== issueKeyString(issue))
        .map((blocker) => known.get(issueKeyString(blocker)))
        .filter((blocker): blocker is PlanIssue => blocker !== undefined && blocker.state === 'open')
        .map((blocker) => ({ repository: blocker.repository, number: blocker.number }));
      return {
        issue: { repository: issue.repository, number: issue.number, title: issue.title, state: issue.state },
        level: layout.levelOf(issue),
        segment: layout.stateOf(issue),
        ...facts(issue, open, waitsOn),
      };
    });

    planOf.set(issueKeyString(planKey), planKey);
    for (const issue of plan.issues) planOf.set(issueKeyString(issue), planKey);

    const lastActivity = [source.updatedAt, ...plan.issues.map((issue) => issue.updatedAt)].sort(newestFirst)[0];
    plans.push(finishPlan(
      { ...planKey, title: plan.title }, source.state, lastActivity, true, rows,
      layout.current, layout.levels.length, isRunning(owner(planKey)),
    ));
  }

  // An issue with sub-issues is a plan before anyone has levelled it.
  for (const issue of input.issues) {
    const planKey = keyOf(issue.number);
    if (issue.subIssueCount === 0 || planOf.has(issueKeyString(planKey))) continue;
    const children = input.issues
      .filter((child) => child.parent === issue.number && !planOf.has(issueKeyString(keyOf(child.number))))
      .sort((a, b) => a.number - b.number);
    const rows = children.map((child): PlanIssueRow<P> => {
      const key = keyOf(child.number);
      const row = facts(key, true, []);
      return {
        issue: { ...key, title: child.title, state: 'open' },
        level: 0,
        segment: row.pullRequest ? 'review' : 'ready',
        ...row,
      };
    });
    planOf.set(issueKeyString(planKey), planKey);
    for (const child of children) planOf.set(issueKeyString(keyOf(child.number)), planKey);
    const closed = Math.max(0, issue.subIssueCount - children.length);
    const segments: NodeState[] = [...Array<NodeState>(closed).fill('closed'), ...rows.map((row) => row.segment)];
    const lastActivity = [issue.updatedAt, ...children.map((child) => child.updatedAt)].sort(newestFirst)[0];
    const plan = finishPlan(
      { ...planKey, title: issue.title }, 'open', lastActivity, false, rows, null, 0, isRunning(owner(planKey)),
    );
    plan.progress = { closed, total: closed + rows.length, current: null, levels: 0, segments };
    plans.push(plan);
  }

  // PRs, each tied to its issues and the plan of the first that has one.
  const pullRequests = input.pullRequests.map((pr): OverviewPullRequestRow<P> => {
    const closes = pr.closes.map(keyOf);
    const plan = closes.map((key) => planOf.get(issueKeyString(key))).find((key) => key !== undefined) ?? null;
    return { pullRequest: pr, closes, plan };
  });
  for (const plan of plans) {
    const planKey = issueKeyString(plan.plan);
    plan.pullRequests = pullRequests
      .filter((row) => row.closes.some((key) => {
        const owner = planOf.get(issueKeyString(key));
        return owner !== undefined && issueKeyString(owner) === planKey;
      }))
      .map((row) => row.pullRequest)
      .sort((a, b) => b.number - a.number);
  }

  const loose = input.issues
    .filter((issue) => issue.parent === null && issue.subIssueCount === 0 && !planOf.has(issueKeyString(keyOf(issue.number))))
    .sort((a, b) => newestFirst(a.updatedAt, b.updatedAt) || b.number - a.number)
    .map((issue): LooseIssueRow<I, P> => ({ issue, ...facts(keyOf(issue.number), true, []) }));

  plans.sort((a, b) =>
    Number(a.state === 'closed') - Number(b.state === 'closed')
    || Number(b.running) - Number(a.running)
    || newestFirst(a.lastActivity, b.lastActivity)
    || b.plan.number - a.plan.number);

  return { plans, loose, pullRequests };
}

/** A plan's row from its issue rows, closed ones moved last; its PRs are gathered once the PRs are. */
function finishPlan<P extends OverviewPullRequest>(
  plan: IssueKey & { title: string },
  state: 'open' | 'closed',
  lastActivity: string,
  levelled: boolean,
  rows: PlanIssueRow<P>[],
  current: number | null,
  levels: number,
  planRunning: boolean,
): OverviewPlan<P> {
  const issues = [...rows.filter((row) => row.issue.state === 'open'), ...rows.filter((row) => row.issue.state === 'closed')];
  return {
    plan,
    state,
    lastActivity,
    levelled,
    issues,
    progress: {
      closed: rows.filter((row) => row.issue.state === 'closed').length,
      total: rows.length,
      current,
      levels,
      segments: rows.map((row) => row.segment),
    },
    running: planRunning || rows.some((row) => row.status?.kind === 'running'),
    pullRequests: [],
  };
}
