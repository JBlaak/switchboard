import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { layOutPlan } from '../src/domain/plan/layout';
import type { StartIssueSessionSteps } from '../src/renderer/ui/session-work/plan/start-issue-session';
import type { SessionOptions } from '../src/domain/launch/session-options';
import { levelStartLine, readyOnLevel, startLevelWith } from '../src/renderer/ui/session-work/plan/start-level';
import { PlanViewContent } from '../src/renderer/ui/session-work/plan/PlanViewContent';
import type { IssueActions } from '../src/renderer/ui/session-work/plan/types';
import { diamond, issue, key, plan, pr } from './support/plans';

test('Start level takes the current level’s Ready issues only', () => {
  /* Given: level 1 is 10 (merged) and 14 (open, Ready) */
  const layout = layOutPlan(diamond());

  /* When */
  const ready = readyOnLevel(layout, 1);

  /* Then */
  assert.deepEqual(ready, [key(14)]);
});

function levelSteps(defaults: SessionOptions = {}, launched: { ok: true; sessionId: string } | { ok: false; reason: string } = { ok: true, sessionId: 'level-session' }) {
  const order: string[] = [];
  const launches: { projectPath: string; options: SessionOptions; show: boolean }[] = [];
  let running = 0;
  const fake: StartIssueSessionSteps = {
    prepare: async ({ issue }) => {
      running++;
      assert.equal(running, 1, 'one worktree at a time');
      order.push('prepare ' + issue.number);
      await new Promise(resolve => setTimeout(resolve, 1));
      running--;
      if (issue.number === 2) return { ok: false, reason: 'Branch 2-issue-2 already exists' };
      if (issue.number === 3) throw new Error('gh went away');
      return { ok: true, worktreePath: '/dev/app/.claude/worktrees/' + issue.number + '-issue', branch: issue.number + '-issue', prompt: 'Work on #' + issue.number + '.' };
    },
    defaultOptions: async () => defaults,
    launch: async (projectPath, options, how) => {
      order.push('launch');
      launches.push({ projectPath, options, show: how.show });
      return launched;
    },
  };
  return { fake, order, launches };
}

const LEVEL = { projectPath: '/dev/app', plan: plan([]), level: 2 };

test('the level starts one session, with every worktree made one after another and a failure or a throw reported', async () => {
  /* Given */
  const { fake, order, launches } = levelSteps({ permissionMode: 'auto', worktree: true, worktreeName: 'x', addDirs: '/shared' });

  /* When */
  const report = await startLevelWith(fake, { ...LEVEL, issues: [key(1), key(2), key(3), key(4)] });

  /* Then */
  assert.deepEqual(order, ['prepare 1', 'prepare 2', 'prepare 3', 'prepare 4', 'launch']);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].projectPath, '/dev/app');
  assert.equal(launches[0].show, false);
  assert.equal(launches[0].options.permissionMode, 'auto');
  assert.equal(launches[0].options.worktree, undefined);
  assert.equal(launches[0].options.worktreeName, undefined);
  assert.equal(launches[0].options.addDirs, '/shared,/dev/app/.claude/worktrees/1-issue,/dev/app/.claude/worktrees/4-issue');
  assert.deepEqual(report, {
    started: 2,
    failed: [{ issue: key(2), reason: 'Branch 2-issue-2 already exists' }, { issue: key(3), reason: 'gh went away' }],
    sessionId: 'level-session',
  });
});

test('the level’s session is told to coordinate an agent per issue, each in its own worktree', async () => {
  /* Given */
  const { fake, launches } = levelSteps();

  /* When */
  await startLevelWith(fake, { ...LEVEL, issues: [key(1), key(4)] });

  /* Then */
  const prompt = launches[0].options.initialPrompt as string;
  assert.match(prompt, /coordinate level 2 of #1: 2 issues/);
  assert.match(prompt, /Do not implement them yourself/);
  assert.match(prompt, /one agent per issue with the Agent tool, all in one message/);
  assert.match(prompt, /- #1: worktree \/dev\/app\/\.claude\/worktrees\/1-issue \(branch 1-issue\)\. Work on #1\./);
  assert.match(prompt, /- #4: worktree \/dev\/app\/\.claude\/worktrees\/4-issue \(branch 4-issue\)\. Work on #4\./);
});

test('no session starts when no worktree was made, and a session that fails to start fails every issue', async () => {
  /* Given */
  const none = levelSteps();
  const broken = levelSteps({}, { ok: false, reason: 'claude not found' });

  /* When */
  const noneReport = await startLevelWith(none.fake, { ...LEVEL, issues: [key(2), key(3)] });
  const brokenReport = await startLevelWith(broken.fake, { ...LEVEL, issues: [key(1), key(2)] });

  /* Then */
  assert.equal(none.launches.length, 0);
  assert.equal(noneReport.started, 0);
  assert.equal(noneReport.failed.length, 2);
  assert.deepEqual(brokenReport, {
    started: 0,
    failed: [
      { issue: key(1), reason: 'The session didn’t start: claude not found' },
      { issue: key(2), reason: 'Branch 2-issue-2 already exists' },
    ],
  });
});

test('the report says how many agents the session started with', () => {
  /* Given */
  const reports = [
    { started: 3, failed: [] }, { started: 1, failed: [] }, { started: 2, failed: [{}] }, { started: 0, failed: [{}, {}] },
  ];

  /* When */
  const lines = reports.map(levelStartLine);

  /* Then */
  assert.deepEqual(lines, [
    'Started a session with 3 agents.', 'Started a session with 1 agent.', 'Started a session with 2 of 3 agents.', 'The session didn’t start.',
  ]);
});

test('the current level’s label offers Start level only with a project and Ready issues', () => {
  /* Given */
  const actions: IssueActions = { startLevel: () => {} };
  const allInReview = plan([issue(1, { pullRequests: [pr(9, 'open')] })]);

  /* When */
  const withProject = renderToStaticMarkup(createElement(PlanViewContent, { plan: diamond(), issueActions: actions }));
  const without = renderToStaticMarkup(createElement(PlanViewContent, { plan: diamond() }));
  const nothingReady = renderToStaticMarkup(createElement(PlanViewContent, { plan: allInReview, issueActions: actions }));

  /* Then */
  assert.equal(withProject.match(/>Start level</g)?.length, 1);
  assert.doesNotMatch(without, />Start level</);
  assert.doesNotMatch(nothingReady, />Start level</);
});

test('the confirmation names the count, and the report lists what failed', () => {
  /* Given */
  const asked: IssueActions = {
    startLevel: () => {},
    levelStart: { plan: key(1), level: 2, issues: [key(11), key(12)], phase: 'confirm' },
  };
  const answered: IssueActions = {
    levelStart: {
      plan: key(1), level: 2, issues: [key(11), key(12)], phase: 'answered', started: 1,
      failed: [{ issue: key(12), reason: 'Branch exists' }],
    },
  };

  /* When */
  const confirm = renderToStaticMarkup(createElement(PlanViewContent, { plan: diamond(), issueActions: asked }));
  const report = renderToStaticMarkup(createElement(PlanViewContent, { plan: diamond(), issueActions: answered }));

  /* Then */
  assert.match(confirm, /Start a session with 2 agents\?/);
  assert.match(confirm, /#11, #12/);
  assert.match(report, /Started a session with 1 of 2 agents\./);
  assert.match(report, /#12: Branch exists/);
});

test('issues a level-up made Ready are drawn arriving', () => {
  /* Given */
  const arriving = [key(14)];

  /* When */
  const html = renderToStaticMarkup(createElement(PlanViewContent, { plan: diamond(), arriving }));

  /* Then */
  assert.match(html, /class="pv-node is-ready is-arriving"[^>]*data-plan-issue="acme\/app#14"/);
});
