import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { layOutPlan } from '../src/domain/plan/layout';
import type { IssueKey } from '../src/domain/plan/model';
import type { IssueSessionStart } from '../src/domain/plan/issue-session';
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

test('sessions start one after another, and a failure or a throw is reported while the rest go on', async () => {
  /* Given */
  const order: string[] = [];
  let running = 0;
  const start = async (issue: IssueKey): Promise<IssueSessionStart> => {
    running++;
    assert.equal(running, 1, 'one start at a time');
    order.push('start ' + issue.number);
    await new Promise(resolve => setTimeout(resolve, 1));
    running--;
    if (issue.number === 2) return { ok: false, reason: 'Branch 2-issue-2 exists' };
    if (issue.number === 3) throw new Error('gh went away');
    return { ok: true, sessionId: 's' + issue.number };
  };

  /* When */
  const report = await startLevelWith(start, [key(1), key(2), key(3), key(4)]);

  /* Then */
  assert.deepEqual(order, ['start 1', 'start 2', 'start 3', 'start 4']);
  assert.deepEqual(report, {
    started: 2,
    failed: [{ issue: key(2), reason: 'Branch 2-issue-2 exists' }, { issue: key(3), reason: 'gh went away' }],
  });
});

test('the report says how many started', () => {
  /* Given */
  const reports = [
    { started: 3, failed: [] }, { started: 2, failed: [{}] }, { started: 0, failed: [{}, {}] }, { started: 0, failed: [{}] },
  ];

  /* When */
  const lines = reports.map(levelStartLine);

  /* Then */
  assert.deepEqual(lines, ['Started 3 sessions.', 'Started 2 of 3 sessions.', 'None of the 2 sessions started.', 'The session didn’t start.']);
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
  assert.match(confirm, /Start 2 sessions\?/);
  assert.match(confirm, /#11, #12/);
  assert.match(report, /Started 1 of 2 sessions\./);
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
