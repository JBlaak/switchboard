/**
 * What the Plan tab's back end answers in its spec, in place of `gh` (see
 * `HostStubs.plans`): the login-fix session works on two plans, a small one
 * of acme/api's built here, and James #22 as GitHub really answered it.
 */
import { S } from './standard';
import { toPlan } from '../../src/infrastructure/github/gh-plans';
import james22 from '../../test/fixtures/gh-plan-james-22.json';
import type { Plan, PlanIssue, PlanPullRequest } from '../../src/domain/plan/model';
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

export const JAMES_PLAN: Plan = toPlan((james22 as { data: unknown }).data, 'JBlaak/James')!;

export function plansStub(): PlansStub {
  return {
    sessionPlans: { [S.loginFix]: { plans: [LOGIN_PLAN, JAMES_PLAN], others: [] } },
    issueSessions: { [REPO]: { [REPO + '#1302']: S.loginFix } },
  };
}
