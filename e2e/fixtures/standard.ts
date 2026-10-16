/**
 * The fixture most tests run against: a small but complete picture of a
 * user's sessions.
 *
 * Each entry is here for a reason the sidebar treats specially, and the names
 * in `S` say which. Tests refer to sessions through `S` and `LABEL` rather than
 * by literal ids, so adding a session here never means editing a test — but
 * moving one in time can change a screenshot, which is the point of having
 * them.
 *
 * With the default `visibleSessionCount` (5) and `sessionMaxAgeDays` (3), the
 * unfiltered list shows Pinned, then the five newest recent rows, and folds the
 * rest behind "+ N older".
 */
import { daysAgo, hoursAgo, minutesAgo, sessionId } from '../support/fixture-home';
import type { FixtureSpec } from '../support/fixture-home';

/** Session ids, by the role each plays. */
export const S = {
  /** The newest session; three PRs, so the row shows two chips and "+1". */
  loginFix: sessionId('login-fix'),
  /** A session run inside a worktree of acme-api; it lists under acme-api. */
  worktreeTry: sessionId('worktree-try'),
  /** Three sessions sharing a slug: one accepted plan, so one group row. */
  billingPlan: sessionId('billing-plan'),
  billingStep1: sessionId('billing-step-1'),
  billingStep2: sessionId('billing-step-2'),
  /** Renamed in Switchboard; the row shows the name, not the prompt. */
  chartsDarkMode: sessionId('charts-dark-mode'),
  /** Pinned, and old enough that only pinning keeps it in view. */
  releaseNotes: sessionId('release-notes'),
  /** Archived: only the archive filter shows it. */
  graphqlSpike: sessionId('graphql-spike'),
  /** In a worktree whose checkout has since been deleted: its own ⎇ project. */
  parserExperiment: sessionId('parser-experiment'),
  /** Older than sessionMaxAgeDays: behind "+ N older". */
  meetingNotes: sessionId('meeting-notes'),
  flakyE2e: sessionId('flaky-e2e'),
  bumpDeps: sessionId('bump-deps'),
  /** The remote project's one session. */
  remoteApi: sessionId('remote-api'),
} as const;

/** What each session's row is labelled. */
export const LABEL = {
  loginFix: 'Fix the login redirect loop',
  worktreeTry: 'Try the session-cookie fix in a worktree',
  billingGroup: 'Refactor billing into its own service',
  chartsDarkMode: 'Charts: dark mode',
  releaseNotes: 'Write the release notes for 2.3',
  graphqlSpike: 'Spike a GraphQL gateway',
  parserExperiment: 'Experiment with a streaming parser',
  meetingNotes: 'Summarise the planning meeting notes',
  flakyE2e: 'Investigate the flaky checkout e2e test',
  bumpDeps: 'Bump dependencies and fix the fallout',
  remoteApi: 'Remote Claude',
} as const;

/** Project paths, relative to the fixture home. */
export const P = {
  acmeApi: 'Development/acme-api',
  webDashboard: 'Development/web-dashboard',
  notes: 'Documents/notes',
  goneParser: 'Development/old-parser/.claude/worktrees/streaming',
} as const;

export const REMOTE = { user: 'joris', host: 'buildbox.local', dir: '~/apps/api' } as const;

export function standardFixture(): FixtureSpec {
  return {
    projects: [
      {
        path: P.acmeApi,
        sessions: [
          {
            id: S.loginFix,
            prompt: LABEL.loginFix,
            at: minutesAgo(20),
            messages: 12,
            pullRequests: [
              { number: 1309, repository: 'acme/api' },
              { number: 1312, repository: 'acme/api' },
              { number: 1320, repository: 'acme/api' },
            ],
          },
          {
            id: S.worktreeTry,
            prompt: LABEL.worktreeTry,
            at: minutesAgo(45),
            cwd: P.acmeApi + '/.claude/worktrees/session-cookie',
          },
          {
            id: S.billingPlan,
            prompt: 'Plan how to move billing out of the monolith',
            at: hoursAgo(5),
            slug: 'gentle-orbiting-falcon',
          },
          {
            id: S.billingStep1,
            prompt: 'Implement the plan: extract the invoice model',
            at: hoursAgo(3),
            slug: 'gentle-orbiting-falcon',
          },
          {
            id: S.billingStep2,
            prompt: 'Implement the plan: move the payment webhooks',
            aiTitle: LABEL.billingGroup,
            at: hoursAgo(1),
            slug: 'gentle-orbiting-falcon',
          },
          {
            id: S.releaseNotes,
            prompt: LABEL.releaseNotes,
            at: daysAgo(5),
            pinned: true,
          },
          {
            id: S.graphqlSpike,
            prompt: LABEL.graphqlSpike,
            at: daysAgo(1),
            archived: true,
          },
        ],
      },
      {
        path: P.webDashboard,
        sessions: [
          {
            id: S.chartsDarkMode,
            prompt: 'Add a dark mode to the dashboard charts',
            name: LABEL.chartsDarkMode,
            at: hoursAgo(2),
            messages: 6,
          },
          { id: S.flakyE2e, prompt: LABEL.flakyE2e, at: daysAgo(6) },
          { id: S.bumpDeps, prompt: LABEL.bumpDeps, at: daysAgo(10), messages: 2 },
        ],
      },
      {
        path: P.notes,
        sessions: [{ id: S.meetingNotes, prompt: LABEL.meetingNotes, at: daysAgo(4) }],
      },
      {
        path: P.goneParser,
        exists: false,
        sessions: [{ id: S.parserExperiment, prompt: LABEL.parserExperiment, at: hoursAgo(30) }],
      },
    ],
    remotes: [
      {
        ...REMOTE,
        sessions: [{ id: S.remoteApi, kind: 'claude', created: daysAgo(2), lastOpened: hoursAgo(3) }],
      },
    ],
  };
}

/** No sessions at all: the first-launch empty screen. */
export function emptyFixture(): FixtureSpec {
  return {};
}
