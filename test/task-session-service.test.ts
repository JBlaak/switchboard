import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TaskSessionService } from '../src/application/services/task-session-service';
import type { BranchSessionCandidate } from '../src/application/services/branch-worktrees';
import type { RouteCandidate, RouteResult } from '../src/domain/ask/model';
import type { WorktreeSummary } from '../src/domain/project/overview';
import type { TaskStartInput } from '../src/domain/tasks/start';
import { FakeStartGit, fakeRouter, type FakeRouter } from './support/fakes';

/**
 * Starting a session from a task, up to the launch: the project it starts in
 * (given, linked or routed), its worktree and branch, and its prompt.
 */

const APP = '/code/app';
const SITE = '/code/site';
const BRANCH = 'call-peter-about-the-invoice';

const task: TaskStartInput = { id: 'task-42', title: 'Call Peter about the invoice', brief: 'He asked twice.' };

const candidates: RouteCandidate[] = [
  { projectPath: APP, folder: '-code-app', recentTitles: [] },
  { projectPath: SITE, folder: '-code-site', recentTitles: [] },
];

interface Harness {
  service: TaskSessionService;
  git: FakeStartGit;
  router: FakeRouter;
}

function harness({
  links = {}, routed = { kind: 'confident', projectPath: SITE, prompt: 'Call Peter.' }, sessions = [], root = APP,
}: {
  links?: Record<string, string>;
  routed?: RouteResult;
  sessions?: BranchSessionCandidate[];
  root?: string;
} = {}): Harness {
  const git = new FakeStartGit(root);
  const router = fakeRouter(routed);
  const service = new TaskSessionService({
    sessions: () => sessions,
    transcripts: { locations: () => [] },
    git: git.port,
    repoOf: (taskId) => links[taskId] ?? null,
    candidates: async () => candidates,
    router,
  });
  return { service, git, router };
}

function checkout(path: string, branch: string, fields: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return { path, branch, main: false, locked: false, changedFiles: 0, ahead: 0, merged: false, lastCommitAt: null, ...fields };
}

// ── The project ──

test('a task linked to a repo starts there, off the default branch, without asking Ask Patch', async () => {
  /* Given */
  const { service, git, router } = harness({ links: { 'task-42': APP } });

  /* When */
  const result = await service.prepare(task);

  /* Then */
  assert.deepEqual(result, {
    kind: 'ready',
    projectPath: APP,
    worktreePath: `${APP}/.claude/worktrees/${BRANCH}`,
    branch: BRANCH,
    prompt: 'Work on my task “Call Peter about the invoice” (blaaktasks task-42): read it with get, log progress at every checkpoint and link the PR. ' +
      'It is already marked In progress; don\'t change its status.',
  });
  assert.deepEqual(git.writes, ['fetch main', `worktree add -b ${BRANCH} ${APP}/.claude/worktrees/${BRANCH} origin/main`]);
  assert.deepEqual(router.requests, []);
});

test('a project given with the request wins over the linked repo, and routing is skipped', async () => {
  /* Given */
  const { service, git, router } = harness({ links: { 'task-42': SITE }, root: APP });

  /* When */
  const result = await service.prepare(task, { projectPath: APP });

  /* Then */
  assert.equal(result.kind === 'ready' && result.projectPath, APP);
  assert.match(git.writes[1], new RegExp(`^worktree add -b ${BRANCH} ${APP}/`));
  assert.deepEqual(router.requests, []);
});

test('a task without a repo asks Ask Patch with its title and brief, and starts at once when it is confident', async () => {
  /* Given */
  const { service, router } = harness({ root: SITE });

  /* When */
  const result = await service.prepare(task);

  /* Then */
  assert.deepEqual(router.requests, [{ text: 'Call Peter about the invoice\n\nHe asked twice.', candidates }]);
  assert.equal(result.kind === 'ready' && result.worktreePath, `${SITE}/.claude/worktrees/${BRANCH}`);
  assert.match(result.kind === 'ready' ? result.prompt : '', /^Work on my task “Call Peter about the invoice”/);
});

test('an unsure Ask Patch answers its suggestions, and nothing is written', async () => {
  /* Given */
  const { service, git } = harness({ routed: { kind: 'unsure', candidates: [SITE, APP], prompt: 'Call Peter.' } });

  /* When */
  const result = await service.prepare(task);

  /* Then */
  assert.deepEqual(result, { kind: 'unsure', candidates: [SITE, APP] });
  assert.deepEqual(git.writes, []);
});

test('no match, a failed call and a cancelled one come back as Ask Patch has them', async () => {
  /* Given */
  const endings: RouteResult[] = [
    { kind: 'noMatch', reason: 'No project fits.' },
    { kind: 'failed', reason: 'Claude took too long to answer.' },
    { kind: 'cancelled' },
  ];

  /* When */
  const results = await Promise.all(endings.map((routed) => harness({ routed }).service.prepare(task)));

  /* Then */
  assert.deepEqual(results, endings);
});

test('a remote project is refused', async () => {
  /* Given */
  const { service, git } = harness();

  /* When */
  const result = await service.prepare(task, { projectPath: 'ssh://box/code/app' });

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: 'A session on a task can only start in a local project' });
  assert.deepEqual(git.writes, []);
});

test('a project outside a git repository is refused', async () => {
  /* Given */
  const { service, git } = harness();
  git.checkout = null;

  /* When */
  const result = await service.prepare(task, { projectPath: '/tmp/notes' });

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: 'Not a git repository: /tmp/notes' });
});

// ── An existing branch ──

test('a branch that already exists is refused, saying where it is and who worked on it, and nothing is written', async () => {
  /* Given */
  const worktree = `${APP}/.claude/worktrees/${BRANCH}`;
  const { service, git } = harness({
    links: { 'task-42': APP },
    sessions: [{ sessionId: 'earlier', projectPath: worktree, folder: null, activeAt: 3 }],
  });
  git.branches.add(BRANCH);
  git.checkouts = [checkout(APP, 'main', { main: true }), checkout(worktree, BRANCH, { changedFiles: 2, ahead: 1 })];

  /* When */
  const result = await service.prepare(task);

  /* Then */
  assert.deepEqual(result, {
    kind: 'existing',
    projectPath: APP,
    reason: `Branch ${BRANCH} already exists`,
    existing: { branch: BRANCH, worktreePath: worktree, main: false, changedFiles: 2, ahead: 1, sessionId: 'earlier' },
  });
  assert.deepEqual(git.writes, []);
});

test('continuing on an existing branch starts in its worktree with the prompt to pick up the work', async () => {
  /* Given */
  const worktree = `${APP}/.claude/worktrees/${BRANCH}`;
  const { service, git } = harness({ links: { 'task-42': APP } });
  git.branches.add(BRANCH);
  git.checkouts = [checkout(worktree, BRANCH)];

  /* When */
  const result = await service.prepare(task, { existing: 'reuse' });

  /* Then */
  assert.equal(result.kind === 'ready' && result.worktreePath, worktree);
  assert.match(result.kind === 'ready' ? result.prompt : '', /^Continue work on my task “Call Peter about the invoice” \(blaaktasks task-42\)/);
  assert.deepEqual(git.writes, []);
});

test('replacing an existing branch deletes its worktree and branch, then starts afresh', async () => {
  /* Given */
  const worktree = `${APP}/.claude/worktrees/${BRANCH}`;
  const { service, git } = harness({ links: { 'task-42': APP } });
  git.branches.add(BRANCH);
  git.checkouts = [checkout(worktree, BRANCH, { changedFiles: 1 })];

  /* When */
  const result = await service.prepare(task, { existing: 'replace' });

  /* Then */
  assert.match(result.kind === 'ready' ? result.prompt : '', /^Work on my task/);
  assert.deepEqual(git.writes, [
    `worktree remove --force ${worktree}`,
    'worktree prune',
    `branch -D ${BRANCH}`,
    'fetch main',
    `worktree add -b ${BRANCH} ${worktree} origin/main`,
  ]);
});

test('a default branch that cannot be fetched starts from the last one fetched, with a warning', async () => {
  /* Given */
  const { service, git } = harness({ links: { 'task-42': APP } });
  git.unfetchable.set('main', 'Could not resolve host: github.com');

  /* When */
  const result = await service.prepare(task);

  /* Then */
  assert.equal(result.kind === 'ready' && result.warning,
    'Could not fetch main (Could not resolve host: github.com); started from the last one fetched.');
});
