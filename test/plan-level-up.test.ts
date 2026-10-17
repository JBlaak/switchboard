import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { planSourceKey, storedLevelsSeen } from '../src/renderer/state/plan-slice';
import type { PlanSource } from '../src/renderer/state/plan-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { Plan } from '../src/domain/plan/model';
import { diamond, issue, key, merged, plan, REPO } from './support/plans';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const OWNER = 'session-work:s1';
const SESSION: PlanSource = { kind: 'session', sessionId: 's1' };
const PLAN_KEY = REPO + '#1';

function load(p: Plan): RendererEvent {
  return { type: 'planLoaded', owner: OWNER, sourceKey: planSourceKey(SESSION), answer: { plans: [p], others: [] } };
}

const open: RendererEvent = { type: 'planViewOpened', owner: OWNER, source: SESSION };

/** The diamond with 14 closed: level 1 cleared, on to level 2, where 12 is Ready. */
function onLevel2(): Plan {
  const d = diamond();
  return { ...d, issues: d.issues.map(i => (i.number === 14 ? { ...i, state: 'closed' as const, closedAs: 'completed' as const } : i)) };
}

function cleared(): Plan {
  return plan([merged(10), merged(11, [10])]);
}

test('the first sighting of a plan records its level and does not celebrate', () => {
  /* Given */
  const opened = run(initialRendererState(), open);

  /* When */
  const state = run(opened, load(diamond()));

  /* Then */
  assert.deepEqual(state.plan.levelsSeen, { [PLAN_KEY]: 1 });
  assert.equal(state.plan.celebration, null);
});

test('a poll that finds the next level queues a level-up with the newly Ready issues', () => {
  /* Given */
  const seen = run(initialRendererState(), open, load(diamond()));

  /* When */
  const state = run(seen, load(onLevel2()));

  /* Then */
  assert.deepEqual(state.plan.levelsSeen, { [PLAN_KEY]: 2 });
  assert.deepEqual(state.plan.celebration, {
    id: 1, plan: key(1), celebration: { kind: 'level-up', level: 2 }, levels: 3, arriving: [key(12)],
  });
});

test('once played, the same level on the next poll queues nothing more', () => {
  /* Given */
  const levelled = run(initialRendererState(), open, load(diamond()), load(onLevel2()));

  /* When */
  const played = run(levelled, { type: 'planCelebrationPlayed', id: 1 });
  const polled = run(played, load(onLevel2()));

  /* Then */
  assert.equal(played.plan.celebration, null);
  assert.equal(polled.plan.celebration, null);
  assert.deepEqual(polled.plan.levelsSeen, played.plan.levelsSeen);
});

test('a level that cleared while the plan was not on screen celebrates when it shows again', () => {
  /* Given: seen on level 1 in an earlier run */
  const restored = run(initialRendererState(), { type: 'planLevelsSeenRestored', seen: { [PLAN_KEY]: 1 } });

  /* When */
  const state = run(restored, open, load(onLevel2()));

  /* Then */
  assert.equal(state.plan.celebration?.celebration.kind, 'level-up');
});

test('a plan cleared after a level queues a cleared celebration with nothing arriving', () => {
  /* Given */
  const restored = run(initialRendererState(), { type: 'planLevelsSeenRestored', seen: { [PLAN_KEY]: 2 } });

  /* When */
  const state = run(restored, open, load(cleared()));

  /* Then */
  assert.deepEqual(state.plan.celebration?.celebration, { kind: 'cleared', level: 2 });
  assert.deepEqual(state.plan.celebration?.arriving, []);
  assert.deepEqual(state.plan.levelsSeen, { [PLAN_KEY]: null });
});

test('a level going back down is recorded without a celebration', () => {
  /* Given */
  const restored = run(initialRendererState(), { type: 'planLevelsSeenRestored', seen: { [PLAN_KEY]: 2 } });

  /* When */
  const state = run(restored, open, load(diamond()));

  /* Then */
  assert.equal(state.plan.celebration, null);
  assert.deepEqual(state.plan.levelsSeen, { [PLAN_KEY]: 1 });
});

test('a failed poll sights nothing', () => {
  /* Given */
  const seen = run(initialRendererState(), open, load(diamond()));

  /* When */
  const state = run(seen, { type: 'planLoaded', owner: OWNER, sourceKey: planSourceKey(SESSION), answer: null });

  /* Then */
  assert.equal(state.plan, seen.plan);
});

test('the switcher sights the plan it picks', () => {
  /* Given */
  const second = plan([issue(20)], { number: 2, title: 'Second' });
  const loaded = run(initialRendererState(), open, {
    type: 'planLoaded', owner: OWNER, sourceKey: planSourceKey(SESSION), answer: { plans: [diamond(), second], others: [] },
  });

  /* When */
  const state = run(loaded, { type: 'planChosen', plan: key(2) });

  /* Then */
  assert.deepEqual(state.plan.levelsSeen, { [PLAN_KEY]: 1, [REPO + '#2']: 1 });
});

test('restoring keeps what was seen since the run started', () => {
  /* Given */
  const seen = run(initialRendererState(), open, load(diamond()));

  /* When */
  const state = run(seen, { type: 'planLevelsSeenRestored', seen: { [PLAN_KEY]: 3, 'acme/other#9': null } });

  /* Then */
  assert.deepEqual(state.plan.levelsSeen, { [PLAN_KEY]: 1, 'acme/other#9': null });
});

test('stored levels read back, dropping anything that is not a level', () => {
  /* Given */
  const raw = JSON.stringify({ 'a/b#1': 2, 'a/b#2': null, 'a/b#3': 'two', 'a/b#4': 0, 'a/b#5': 1.5 });

  /* When */
  const seen = storedLevelsSeen(raw);

  /* Then */
  assert.deepEqual(seen, { 'a/b#1': 2, 'a/b#2': null });
  assert.deepEqual(storedLevelsSeen('not json'), {});
  assert.deepEqual(storedLevelsSeen(null), {});
  assert.deepEqual(storedLevelsSeen('[1]'), {});
});

test('Start level asks, starts and answers; cancel and dismiss put it away', () => {
  /* Given */
  const issues = [key(12), key(14)];

  /* When */
  const asked = run(initialRendererState(), { type: 'planLevelStartAsked', plan: key(1), level: 1, issues });
  const starting = run(asked, { type: 'planLevelStartConfirmed' });
  const cancelWhileStarting = run(starting, { type: 'planLevelStartCancelled' });
  const answered = run(starting, { type: 'planLevelStartAnswered', started: 1, failed: [{ issue: key(14), reason: 'Branch exists' }] });
  const dismissed = run(answered, { type: 'planLevelStartCancelled' });
  const cancelled = run(asked, { type: 'planLevelStartCancelled' });

  /* Then */
  assert.equal(asked.plan.levelStart?.phase, 'confirm');
  assert.deepEqual(asked.plan.levelStart?.issues, issues);
  assert.equal(starting.plan.levelStart?.phase, 'starting');
  assert.equal(cancelWhileStarting.plan, starting.plan);
  assert.deepEqual(answered.plan.levelStart, {
    plan: key(1), level: 1, issues, phase: 'answered', started: 1, failed: [{ issue: key(14), reason: 'Branch exists' }],
  });
  assert.equal(dismissed.plan.levelStart, null);
  assert.equal(cancelled.plan.levelStart, null);
});

test('a level start survives the plan view closing under it', () => {
  /* Given */
  const starting = run(initialRendererState(), open,
    { type: 'planLevelStartAsked', plan: key(1), level: 1, issues: [key(12)] }, { type: 'planLevelStartConfirmed' });

  /* When */
  const state = run(starting, { type: 'planViewClosed', owner: OWNER }, { type: 'planLevelStartAnswered', started: 1, failed: [] });

  /* Then */
  assert.equal(state.plan.view, null);
  assert.equal(state.plan.levelStart?.phase, 'answered');
});
