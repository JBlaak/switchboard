import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { layOutPlan } from '../src/domain/plan/layout';
import { PlanViewContent } from '../src/renderer/ui/session-work/plan/PlanViewContent';
import { hereLabel, levelStatus, warningText } from '../src/renderer/ui/session-work/plan/describe';
import { deleteLine, existingLine, stackLine } from '../src/renderer/ui/session-work/plan/IssueDetail';
import type { IssueActions } from '../src/renderer/ui/session-work/plan/types';
import type { ExistingIssueBranch } from '../src/domain/plan/issue-session';
import { diamond, issue, key, merged, needs, plan, pr } from './support/plans';

test('the view draws a plan given directly, with no session around it (F2)', () => {
  /* When */
  const html = renderToStaticMarkup(createElement(PlanViewContent, { plan: diamond() }));

  /* Then */
  assert.match(html, /Epic/);
  assert.match(html, /Level 1 of 3/);
  for (const n of [10, 11, 12, 13, 14]) assert.match(html, new RegExp(`data-plan-issue="acme/app#${n}"`));
  assert.doesNotMatch(html, /Issue detail/);
});

test('a selected issue shows its detail, with Needs and Unlocks and no session buttons', () => {
  /* When */
  const html = renderToStaticMarkup(createElement(PlanViewContent, {
    plan: diamond(), ui: { chosen: null, hovered: null, selected: key(11) },
  }));

  /* Then */
  assert.match(html, /aria-label="Issue detail"/);
  assert.match(html, /#10 Issue 10/);
  assert.match(html, /#13 Issue 13/);
  assert.match(html, /Open PR #111/);
  assert.doesNotMatch(html, /Start session/);
  assert.doesNotMatch(html, /Jump to/);
});

test('two plans show a switcher; none shows the repository’s open plans (W2)', () => {
  /* Given */
  const other = plan([issue(20)], { number: 2, title: 'Second' });
  const summary = { repository: 'acme/app', number: 3, title: 'Third', state: 'open' as const, updatedAt: '', open: 2, total: 5, current: 1, levels: 3 };

  /* When */
  const two = renderToStaticMarkup(createElement(PlanViewContent, { sessionPlans: { plans: [diamond(), other], others: [] } }));
  const none = renderToStaticMarkup(createElement(PlanViewContent, { sessionPlans: { plans: [], others: [summary] } }));

  /* Then */
  assert.match(two, /role="group" aria-label="Plan"/);
  assert.match(none, /Third/);
  assert.match(none, /Level 1 of 3 · 3\/5/);
});

test('a plan of unlinked issues, one closed by hand, warns of both (D5)', () => {
  /* Given */
  const p = plan([issue(113, { state: 'closed', closedAs: 'completed' }), issue(114)]);

  /* When */
  const warnings = layOutPlan(p).warnings.map(warning => warningText(p, warning).title);

  /* Then */
  assert.deepEqual(warnings, ['No dependency links.', '#113 closed without a PR.']);
});

test('the bands say where you are, what cleared early, and what is locked (D2)', () => {
  /* Given */
  const p = plan([issue(1), merged(2, []), needs(3, [1]), merged(4, [2])]);
  const p2 = plan([issue(1), needs(2, [1]), merged(3, [2])]);

  /* When */
  const layout = layOutPlan(p);
  const layout2 = layOutPlan(p2);

  /* Then */
  assert.equal(hereLabel(layout), 'Level 1 of 2');
  assert.equal(levelStatus(p, layout, 1).label, 'You are here');
  assert.equal(levelStatus(p, layout, 2).label, 'Locked');
  assert.equal(levelStatus(p2, layout2, 3).label, 'Cleared early');
});

test('the header shows one coloured bullet per level, not one per issue (D2)', () => {
  /* Given */
  const p = plan([
    merged(1), merged(2), merged(3), merged(4),
    merged(5, [1]), needs(6, [1], { pullRequests: [pr(60, 'open')] }), needs(7, [1]), needs(8, [1]),
    ...[9, 10, 11, 12].map(n => needs(n, [5])),
    ...[13, 14, 15, 16].map(n => needs(n, [9])),
    ...[17, 18, 19, 20].map(n => needs(n, [13])),
  ]);

  /* When */
  const html = renderToStaticMarkup(createElement(PlanViewContent, { plan: p }));

  /* Then */
  const bullets = [...html.matchAll(/class="level-bullet is-([a-z-]+)"/g)].map(match => match[1]);
  assert.deepEqual(bullets, ['done', 'in-progress', 'open', 'open', 'open']);
});

test('starting a Locked issue early says what it stacks on (A3)', () => {
  /* Given */
  const stacked = plan([needs(1, [], { pullRequests: [pr(50, 'open')] }), needs(2, [1])]);
  const ahead = plan([issue(1), needs(2, [1])]);

  /* When */
  const onPr = stackLine(stacked, key(2));
  const noPr = stackLine(ahead, key(2));

  /* Then */
  assert.match(onPr, /Stacked on #1: branches off PR #50/);
  assert.match(noPr, /ahead of #1/);
});

function existingBranch(fields: Partial<ExistingIssueBranch> = {}): ExistingIssueBranch {
  return {
    branch: '10-issue', worktreePath: '/dev/app/.claude/worktrees/10-issue', main: false,
    changedFiles: 0, ahead: 0, sessionId: null, ...fields,
  };
}

function refusedOver(existing: ExistingIssueBranch): IssueActions {
  return {
    startSession: () => {},
    startAgain: () => {},
    jumpToSession: () => {},
    start: { issue: key(10), phase: 'answered', result: { ok: false, reason: 'Branch 10-issue already exists', existing } },
  };
}

test('a start refused over an existing branch offers to continue, open its session, or delete it', () => {
  /* Given */
  const actions = refusedOver(existingBranch({ sessionId: 'earlier', changedFiles: 2, ahead: 1 }));

  /* When */
  const html = renderToStaticMarkup(createElement(PlanViewContent, {
    plan: diamond(), ui: { chosen: null, hovered: null, selected: key(10) }, issueActions: actions,
  }));

  /* Then */
  assert.match(html, /in a worktree with 2 uncommitted files and 1 commit not on the default branch/);
  assert.match(html, />Continue work</);
  assert.match(html, />Open its session</);
  assert.match(html, />Delete worktree and branch…</);
  assert.match(html, /Branch 10-issue/);
  assert.doesNotMatch(html, /pv-inline is-error/);
  assert.doesNotMatch(html, /Start session on #10/);
});

test('an existing branch no session worked on offers no session to open', () => {
  /* Given */
  const actions = refusedOver(existingBranch({ worktreePath: null }));

  /* When */
  const html = renderToStaticMarkup(createElement(PlanViewContent, {
    plan: diamond(), ui: { chosen: null, hovered: null, selected: key(10) }, issueActions: actions,
  }));

  /* Then */
  assert.match(html, /exists already, without a worktree/);
  assert.match(html, />Delete branch…</);
  assert.doesNotMatch(html, /Open its session/);
});

test('an existing branch in the main checkout is never offered for deletion', () => {
  /* Given */
  const actions = refusedOver(existingBranch({ worktreePath: '/dev/app', main: true, sessionId: 'earlier' }));

  /* When */
  const html = renderToStaticMarkup(createElement(PlanViewContent, {
    plan: diamond(), ui: { chosen: null, hovered: null, selected: key(10) }, issueActions: actions,
  }));

  /* Then */
  assert.match(html, /checked out in the main checkout/);
  assert.match(html, />Continue work</);
  assert.doesNotMatch(html, /Delete/);
});

test('deleting an existing branch names what goes with it', () => {
  /* Given */
  const dirty = existingBranch({ changedFiles: 1, ahead: 3 });
  const clean = existingBranch({ worktreePath: null });

  /* When */
  const withWork = deleteLine(dirty);
  const without = deleteLine(clean);

  /* Then */
  assert.equal(withWork, 'Delete its worktree and branch, with 1 uncommitted file and 3 commits not on the default branch? Anything not pushed is gone for good.');
  assert.equal(without, 'Delete its branch, then start again from scratch? Anything not pushed is gone for good.');
  assert.equal(existingLine(existingBranch()), 'Its branch exists already, in a worktree with no work on it yet.');
});
