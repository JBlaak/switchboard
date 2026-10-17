import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rekeyState, rootReducer } from '../src/renderer/state/root';
import { chosenPlan, planSourceKey, steppedIssue } from '../src/renderer/state/plan-slice';
import type { PlanSource } from '../src/renderer/state/plan-slice';
import { workTabOf } from '../src/renderer/state/session-work-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import { diamond, key, plan, issue, REPO } from './support/plans';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const OWNER = 'session-work:s1';
const SESSION: PlanSource = { kind: 'session', sessionId: 's1' };
const second = plan([issue(20), issue(21)], { number: 2, title: 'Second' });

function opened(): RendererState {
  return run(initialRendererState(), { type: 'planViewOpened', owner: OWNER, source: SESSION });
}

function loaded(): RendererState {
  return run(opened(), {
    type: 'planLoaded', owner: OWNER, sourceKey: planSourceKey(SESSION),
    answer: { plans: [diamond(), second], others: [] },
  });
}

test('a plan view opens loading, with nothing chosen, hovered or selected', () => {
  /* When */
  const state = opened();

  /* Then */
  assert.equal(state.plan.view?.phase, 'loading');
  assert.equal(state.plan.view?.answer, null);
  assert.equal(state.plan.view?.selected, null);
});

test('opening the same view again changes nothing', () => {
  /* Given */
  const state = loaded();

  /* When */
  const next = run(state, { type: 'planViewOpened', owner: OWNER, source: SESSION });

  /* Then */
  assert.equal(next, state);
});

test('a home closes only its own view', () => {
  /* Given */
  const state = loaded();

  /* When */
  const other = run(state, { type: 'planViewClosed', owner: 'main:plan' });
  const own = run(state, { type: 'planViewClosed', owner: OWNER });

  /* Then */
  assert.equal(other, state);
  assert.equal(own.plan.view, null);
});

test('the first plan is shown until another is chosen (W2)', () => {
  /* Given */
  const state = loaded();

  /* When */
  const next = run(state, { type: 'planChosen', plan: key(2) });

  /* Then */
  assert.equal(chosenPlan(state.plan.view!)?.number, 1);
  assert.equal(chosenPlan(next.plan.view!)?.number, 2);
});

test('choosing a plan that is not in the answer does nothing', () => {
  /* Given */
  const state = loaded();

  /* When */
  const next = run(state, { type: 'planChosen', plan: key(99) });

  /* Then */
  assert.equal(next, state);
});

test('an answer for another source is dropped', () => {
  /* Given */
  const state = opened();

  /* When */
  const next = run(state, { type: 'planLoaded', owner: OWNER, sourceKey: 'session:other', answer: { plans: [], others: [] } });

  /* Then */
  assert.equal(next, state);
});

test('a failed first load fails; a failed poll keeps the last answer', () => {
  /* Given */
  const fresh = opened();
  const known = loaded();

  /* When */
  const first = run(fresh, { type: 'planLoaded', owner: OWNER, sourceKey: planSourceKey(SESSION), answer: null });
  const poll = run(known, { type: 'planLoaded', owner: OWNER, sourceKey: planSourceKey(SESSION), answer: null });

  /* Then */
  assert.equal(first.plan.view?.phase, 'failed');
  assert.equal(poll, known);
});

test('selecting an issue opens its detail, and selecting null closes it', () => {
  /* Given */
  const state = loaded();

  /* When */
  const selected = run(state, { type: 'planIssueSelected', issue: key(12) });
  const closed = run(selected, { type: 'planIssueSelected', issue: null });

  /* Then */
  assert.deepEqual(selected.plan.view?.selected, key(12));
  assert.equal(closed.plan.view?.selected, null);
});

test('an issue outside the shown plan cannot be selected', () => {
  /* Given */
  const state = loaded();

  /* When */
  const next = run(state, { type: 'planIssueSelected', issue: key(20) });

  /* Then */
  assert.equal(next, state);
});

test('hovering sets and clears the hovered issue, and hovering it again changes nothing', () => {
  /* Given */
  const hovered = run(loaded(), { type: 'planIssueHovered', issue: key(11) });

  /* When */
  const again = run(hovered, { type: 'planIssueHovered', issue: key(11) });
  const left = run(hovered, { type: 'planIssueHovered', issue: null });

  /* Then */
  assert.equal(again, hovered);
  assert.equal(left.plan.view?.hovered, null);
});

test('choosing another plan clears the hover and the selection', () => {
  /* Given */
  const state = run(loaded(), { type: 'planIssueSelected', issue: key(12) }, { type: 'planIssueHovered', issue: key(11) });

  /* When */
  const next = run(state, { type: 'planChosen', plan: key(2) });

  /* Then */
  assert.equal(next.plan.view?.selected, null);
  assert.equal(next.plan.view?.hovered, null);
});

test('a poll that no longer has the selected issue closes its detail', () => {
  /* Given */
  const state = run(loaded(), { type: 'planIssueSelected', issue: key(13) });

  /* When */
  const next = run(state, {
    type: 'planLoaded', owner: OWNER, sourceKey: planSourceKey(SESSION),
    answer: { plans: [plan([issue(10)])], others: [] },
  });

  /* Then */
  assert.equal(next.plan.view?.selected, null);
});

test('picking another plan loads it, and going back returns to where the view opened', () => {
  /* Given */
  const state = loaded();
  const other: PlanSource = { kind: 'plan', repository: REPO, number: 7 };

  /* When */
  const picked = run(state, { type: 'planSourcePicked', owner: OWNER, source: other });

  /* Then */
  assert.equal(picked.plan.view?.phase, 'loading');
  assert.deepEqual(picked.plan.view?.from, SESSION);

  /* When */
  const back = run(picked, { type: 'planSourcePicked', owner: OWNER, source: SESSION });

  /* Then */
  assert.deepEqual(back.plan.view?.source, SESSION);
  assert.equal(back.plan.view?.from, null);
});

test('owners are kept per view, and the same owners again change nothing', () => {
  /* Given */
  const state = run(loaded(), { type: 'planOwnersLoaded', owner: OWNER, owners: { [REPO + '#11']: 's9' } });

  /* When */
  const same = run(state, { type: 'planOwnersLoaded', owner: OWNER, owners: { [REPO + '#11']: 's9' } });

  /* Then */
  assert.equal(same, state);
  assert.deepEqual(state.plan.view?.owners, { [REPO + '#11']: 's9' });
});

test('a Locked issue asks to confirm its start; cancelling forgets it', () => {
  /* Given */
  const state = run(loaded(), { type: 'planIssueSelected', issue: key(13) });

  /* When */
  const asking = run(state, { type: 'planStartAsked', issue: key(13), confirm: true });
  const cancelled = run(asking, { type: 'planStartCancelled' });

  /* Then */
  assert.equal(asking.plan.view?.start?.phase, 'confirm');
  assert.equal(cancelled.plan.view?.start, null);
});

test('a start is answered on its issue, and stays while it is on its way', () => {
  /* Given */
  const starting = run(loaded(), { type: 'planIssueSelected', issue: key(12) }, { type: 'planStartAsked', issue: key(12), confirm: false });

  /* When */
  const moved = run(starting, { type: 'planIssueSelected', issue: key(11) });
  const answered = run(moved, { type: 'planStartAnswered', issue: key(12), result: { ok: false, reason: 'No repository' } });

  /* Then */
  assert.equal(moved.plan.view?.start?.phase, 'starting');
  assert.deepEqual(answered.plan.view?.start, { issue: key(12), phase: 'answered', result: { ok: false, reason: 'No repository' } });
});

test('starting an issue that is not selected does nothing', () => {
  /* Given */
  const state = loaded();

  /* When */
  const next = run(state, { type: 'planStartAsked', issue: key(12), confirm: false });

  /* Then */
  assert.equal(next, state);
});

test('↑/↓ step in level order, start at the first, and stop at the ends', () => {
  /* Given */
  const order = [key(10), key(14), key(11), key(12), key(13)];

  /* When */
  const first = steppedIssue(order, null, 1);
  const down = steppedIssue(order, key(14), 1);
  const up = steppedIssue(order, key(14), -1);
  const end = steppedIssue(order, key(13), 1);

  /* Then */
  assert.deepEqual(first, key(10));
  assert.deepEqual(down, key(11));
  assert.deepEqual(up, key(10));
  assert.equal(end, null);
});

test('a re-keyed session keeps its Plan tab and its tab choice', () => {
  /* Given */
  const state = run(loaded(), { type: 'sessionWorkTabSet', sessionId: 's1', tab: 'plan' });

  /* When */
  const next = rekeyState(state, 's1', 's2');

  /* Then */
  assert.equal(next.plan.view?.owner, 'session-work:s2');
  assert.deepEqual(next.plan.view?.source, { kind: 'session', sessionId: 's2' });
  assert.equal(workTabOf(next.sessionWork, 's2'), 'plan');
  assert.equal(workTabOf(next.sessionWork, 's1'), 'work');
});

test('the tab is kept per session, Work unless Plan was picked (W1)', () => {
  /* Given */
  const state = run(initialRendererState(), { type: 'sessionWorkTabSet', sessionId: 'a', tab: 'plan' });

  /* When */
  const back = run(state, { type: 'sessionWorkTabSet', sessionId: 'a', tab: 'work' });

  /* Then */
  assert.equal(workTabOf(state.sessionWork, 'a'), 'plan');
  assert.equal(workTabOf(state.sessionWork, 'b'), 'work');
  assert.deepEqual(back.sessionWork.tabs, {});
});
