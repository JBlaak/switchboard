/**
 * What the Plan tab's back end answers in its spec, in place of `gh` (see
 * `HostStubs.plans`): the login-fix session works on two plans, a small one
 * of acme/api's built here, and James #22 as GitHub really answered it.
 */
import { P, S } from './standard';
import { toPlan } from '../../src/infrastructure/github/gh-plans';
import james22 from '../../test/fixtures/gh-plan-james-22.json';
import type { Plan, PlanIssue, PlanPullRequest, PlanSummary } from '../../src/domain/plan/model';
import type { PlansStub } from '../support/main-process';

const REPO = 'acme/api';

function pr(number: number, state: PlanPullRequest['state']): PlanPullRequest {
  return { number, state, draft: false, additions: 120, deletions: 14, headRef: 'fix/' + number, baseRef: 'main' };
}

function issue(number: number, title: string, fields: Partial<PlanIssue> = {}): PlanIssue {
  return {
    repository: REPO, number, title, state: 'open', closedAs: null, updatedAt: '2026-10-17T10:00:00Z',
    blockedBy: [], pullRequests: [], summary: 'What ' + title.toLowerCase() + ' needs to do.', acceptance: [],
    ...fields,
  };
}

const blockers = (...numbers: number[]) => numbers.map(number => ({ repository: REPO, number }));

export const LOGIN_PLAN: Plan = {
  repository: REPO,
  number: 1300,
  title: 'Login rework',
  parent: null,
  issues: [
    issue(1301, 'Cookie store behind a port', { state: 'closed', closedAs: 'completed', pullRequests: [pr(1310, 'merged')] }),
    issue(1302, 'Stop the login redirect loop', {
      blockedBy: blockers(1301), pullRequests: [pr(1320, 'open')],
      acceptance: [{ text: 'A logged-out user lands on /login once', done: true }, { text: 'The loop has a regression test', done: false }],
    }),
    issue(1303, 'Remember me for 30 days', { blockedBy: blockers(1301) }),
    issue(1304, 'Single sign-on with the identity provider', {
      blockedBy: [...blockers(1302, 1303), { repository: 'acme/infra', number: 7 }],
    }),
    issue(1305, 'Magic links', { state: 'closed', closedAs: 'not_planned' }),
  ],
  outside: [
    { ...issue(7, 'Identity provider tenant'), repository: 'acme/infra' },
  ],
};

/** The login plan once level 2 cleared: #1302 and #1303 merged, on to level 3 (A4). */
export const LOGIN_PLAN_ON_LEVEL_3: Plan = {
  ...LOGIN_PLAN,
  issues: LOGIN_PLAN.issues.map(i => (i.number === 1302 || i.number === 1303
    ? { ...i, state: 'closed', closedAs: 'completed', pullRequests: [pr(i.number + 20, 'merged')] }
    : i)),
};

export const JAMES_PLAN: Plan = toPlan((james22 as { data: unknown }).data, 'JBlaak/James')!;

function planSummary(number: number, title: string, fields: Partial<PlanSummary> = {}): PlanSummary {
  return {
    repository: REPO, number, title, state: 'open', updatedAt: '2026-10-10T10:00:00Z',
    open: 2, total: 4, current: 1, levels: 2,
    ...fields,
  };
}

/** acme/api's plans in the New Session picker (#128): open and closed together. */
export const ACME_PLANS: PlanSummary[] = [
  planSummary(1200, 'Rate limiting at the edge', { updatedAt: '2026-10-12T09:00:00Z' }),
  planSummary(1300, 'Login rework', { updatedAt: '2026-10-17T10:00:00Z', open: 3, total: 5, current: 2, levels: 3 }),
  planSummary(900, 'Move to Postgres 16', { state: 'closed', open: 0, total: 6, current: null, levels: 2 }),
];

/** `login`: the login plan as GitHub answers it now; a test swaps in another with `setHostStub`. */
export function plansStub(login: Plan = LOGIN_PLAN): PlansStub {
  return {
    sessionPlans: { [S.loginFix]: { plans: [login, JAMES_PLAN], others: [] } },
    issueSessions: { [REPO]: { [REPO + '#1302']: S.loginFix } },
    plans: { [REPO + '#1300']: LOGIN_PLAN },
    // web-dashboard is not on GitHub: the picker's → finds no plans there.
    projectPlans: { [P.acmeApi]: ACME_PLANS, [P.webDashboard]: null },
  };
}
