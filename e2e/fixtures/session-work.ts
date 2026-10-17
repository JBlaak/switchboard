/**
 * What the Session work page's back end answers in its spec, in place of git
 * and `gh`.
 *
 * The fixture home has no git repositories and the suite must never reach
 * GitHub, so the page's two requests are stubbed (see `HostStubs.sessionWork`):
 * the login-fix session (the standard fixture's acme-api, with its three PRs)
 * and the dashboard one can open; everything else answers as a session outside
 * a repository does. The snapshot has one of every kind of item, and the
 * first and the merged PR have a diff.
 */
import { FIXTURE_NOW } from '../support/fixture-home';
import { S } from './standard';
import { parseUnifiedDiff } from '../../src/domain/session-work/diff';
import type { SessionWorkStub } from '../support/main-process';
import type { Activity, PullRequestStatus, SessionWorkItem, SessionWorkSnapshot } from '../../src/domain/session-work/model';

const REPO = 'acme/api';
const pr = (n: number) => `https://github.com/${REPO}/pull/${n}`;

const ITEMS: SessionWorkItem[] = [
  {
    id: 'pr:' + pr(1320),
    kind: 'pr',
    pr: {
      number: 1320, url: pr(1320), repository: REPO, title: 'Stop the login redirect loop', state: 'open',
      checks: [{ name: 'test', state: 'passing' }], behindBy: 2, baseRef: 'main', headRef: 'fix/login-loop',
      additions: 42, deletions: 9,
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
    id: 'branch:/w/acme-api-2\0spike/cookie-store',
    kind: 'branch',
    location: { worktree: '/w/acme-api-2', branch: 'spike/cookie-store', fromSubagent: true },
    ahead: 2,
    diff: { kind: 'local', worktree: '/w/acme-api-2', base: 'origin/main', head: 'spike/cookie-store' },
    activity: null,
    additions: 61,
    deletions: 0,
    pushed: false,
  },
  {
    id: 'dirty:/w/acme-api\0fix/login-loop',
    kind: 'dirty',
    location: { worktree: '/w/acme-api', branch: 'fix/login-loop', fromSubagent: false },
    files: [{ path: 'src/session.ts', status: 'modified' }, { path: 'src/cookie.ts', status: 'untracked' }],
    additions: 18,
    deletions: 4,
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
    id: 'issue:acme/api#1288',
    kind: 'issue',
    issue: {
      repository: REPO, number: 1288, title: 'Session cookie not marked Secure', state: 'closed',
      url: `https://github.com/${REPO}/issues/1288`,
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
  sessionId: S.loginFix, repository: REPO, items: ITEMS, queued: 0, gh: 'ok', updatedAt: UPDATED_AT,
};

export const DASHBOARD_WORK: SessionWorkSnapshot = {
  sessionId: S.chartsDarkMode, repository: 'acme/dashboard', items: [], queued: 0, gh: 'unauthenticated', updatedAt: UPDATED_AT,
};

/** The first PR's item id. */
export const FIRST_PR_ID = 'pr:' + pr(1320);

/**
 * The login-fix snapshot with an action on its first PR, as the queue would
 * push it, and `queued` actions waiting in all. `facts` changes what GitHub
 * says about that PR.
 */
export function loginFixWorkWith(
  activity: Activity, { queued = 0, facts = {} }: { queued?: number; facts?: Partial<PullRequestStatus> } = {},
): SessionWorkSnapshot {
  const items = ITEMS.map((item): SessionWorkItem =>
    item.id === FIRST_PR_ID && item.kind === 'pr' ? { ...item, pr: { ...item.pr, ...facts }, activity } : item);
  return { ...LOGIN_FIX_WORK, items, queued };
}

/** How many lines the large file adds: enough that drawing it at once would block input. */
export const BIG_FILE_LINES = 5000;

/**
 * The first PR's diff, from its local branch: a change to read unified and
 * split, a lock file and a large file that start collapsed, and a binary file.
 */
const LOGIN_LOOP_DIFF = [
  'diff --git a/src/session.ts b/src/session.ts',
  'index 1111111..2222222 100644',
  '--- a/src/session.ts',
  '+++ b/src/session.ts',
  '@@ -10,6 +10,7 @@ export function refresh(session: Session) {',
  '   const token = session.token;',
  '-  if (!token) return redirect("/login");',
  '-  return renew(token);',
  '+  if (!token) return null;',
  '+  const next = renew(token);',
  '+  return next ?? null;',
  '   // never loop back to /login from here',
  ' }',
  ' ',
  'diff --git a/package-lock.json b/package-lock.json',
  'index 3333333..4444444 100644',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,3 +1,3 @@',
  ' {',
  '-  "version": "1.0.0",',
  '+  "version": "1.0.1",',
  ' }',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 5555555..6666666 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/src/fixtures/big.ts b/src/fixtures/big.ts',
  'new file mode 100644',
  'index 0000000..7777777',
  '--- /dev/null',
  '+++ b/src/fixtures/big.ts',
  `@@ -0,0 +1,${BIG_FILE_LINES} @@`,
  ...Array.from({ length: BIG_FILE_LINES }, (_, i) => `+export const line${i + 1} = ${i + 1};`),
  '',
].join('\n');

/** The merged PR's diff, which came from `gh pr diff`: its branch is not checked out. */
const REDIRECT_CHAIN_DIFF = [
  'diff --git a/src/log.ts b/src/log.ts',
  '--- a/src/log.ts',
  '+++ b/src/log.ts',
  '@@ -1 +1,2 @@',
  ' export const log = console.log;',
  '+export const chain: string[] = [];',
  '',
].join('\n');

export function sessionWorkStub(): SessionWorkStub {
  return {
    canOpen: [S.loginFix, S.chartsDarkMode],
    snapshots: { [S.loginFix]: LOGIN_FIX_WORK, [S.chartsDarkMode]: DASHBOARD_WORK },
    diffs: {
      ['pr:' + pr(1320)]: { files: parseUnifiedDiff(LOGIN_LOOP_DIFF), source: 'local' },
      ['pr:' + pr(1309)]: { files: parseUnifiedDiff(REDIRECT_CHAIN_DIFF), source: 'github' },
    },
  };
}
