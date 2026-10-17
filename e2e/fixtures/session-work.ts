/**
 * What the Session work page's back end answers in its spec, in place of git
 * and `gh`.
 *
 * The fixture home has no git repositories and the suite must never reach
 * GitHub, so the page's two requests are stubbed (see `HostStubs.sessionWork`):
 * the login-fix session (the standard fixture's acme-api, with its three PRs)
 * and the dashboard one can open; everything else answers as a session outside
 * a repository does. The snapshot has one of every kind of item.
 */
import { FIXTURE_NOW } from '../support/fixture-home';
import { S } from './standard';
import type { SessionWorkStub } from '../support/main-process';
import type { SessionWorkItem, SessionWorkSnapshot } from '../../src/domain/session-work/model';

const REPO = 'acme/api';
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

const ITEMS: SessionWorkItem[] = [
  {
    id: 'pr:' + pr(1320),
    kind: 'pr',
    pr: {
      number: 1320, url: pr(1320), repository: REPO, title: 'Stop the login redirect loop', state: 'open',
      checks: [{ name: 'test', state: 'passing' }], behindBy: 2, baseRef: 'main', headRef: 'fix/login-loop',
      closes: [{ repository: '', number: 1301 }],
    },
    location: { worktree: '/w/acme-api', branch: 'fix/login-loop', fromSubagent: false },
    diff: { kind: 'local', worktree: '/w/acme-api', base: 'origin/main', head: 'fix/login-loop' },
    activity: null,
  },
  {
    id: 'pr:' + pr(1312),
    kind: 'pr',
    pr: {
      number: 1312, url: pr(1312), repository: REPO, title: 'Add a regression test for the redirect', state: 'draft',
      checks: [{ name: 'test', state: 'failing' }], headRef: 'test/redirect', closes: [],
    },
    location: { worktree: '/w/acme-api-2', branch: 'test/redirect', fromSubagent: true },
    diff: { kind: 'local', worktree: '/w/acme-api-2', base: 'origin/main', head: 'test/redirect' },
    activity: null,
  },
  {
    id: 'dirty:/w/acme-api\0fix/login-loop',
    kind: 'dirty',
    location: { worktree: '/w/acme-api', branch: 'fix/login-loop', fromSubagent: false },
    files: [{ path: 'src/session.ts', status: 'modified' }, { path: 'src/cookie.ts', status: 'untracked' }],
  },
  {
    id: 'issue:acme/api#1290',
    kind: 'issue',
    issue: {
      repository: REPO, number: 1290, title: 'Users get logged out on refresh', state: 'open',
      url: `https://github.com/${REPO}/issues/1290`,
    },
  },
  {
    id: 'pr:' + pr(1309),
    kind: 'pr',
    pr: { number: 1309, url: pr(1309), repository: REPO, title: 'Log the redirect chain', state: 'merged', closes: [] },
    location: null,
    diff: { kind: 'pull-request', repository: REPO, number: 1309 },
    activity: null,
  },
];

/** Assembled four seconds before the renderer's frozen clock: "updated 4s ago". */
const UPDATED_AT = new Date(FIXTURE_NOW - 4000).toISOString();

export const LOGIN_FIX_WORK: SessionWorkSnapshot = {
  sessionId: S.loginFix, repository: REPO, items: ITEMS, gh: 'ok', updatedAt: UPDATED_AT,
};

export const DASHBOARD_WORK: SessionWorkSnapshot = {
  sessionId: S.chartsDarkMode, repository: 'acme/dashboard', items: [], gh: 'unauthenticated', updatedAt: UPDATED_AT,
};

export function sessionWorkStub(): SessionWorkStub {
  return {
    canOpen: [S.loginFix, S.chartsDarkMode],
    snapshots: { [S.loginFix]: LOGIN_FIX_WORK, [S.chartsDarkMode]: DASHBOARD_WORK },
  };
}
