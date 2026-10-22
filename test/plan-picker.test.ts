/**
 * Plans in the New Session picker (#128, F1, F3): their order (opened
 * recently first, then by activity), the filter, what a row
 * says, and the picker's keys into and out of a project's plans.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterPlans, orderPlans, planClosedLabel, planLevelLabel, planLevelSegments,
} from '../src/renderer/ui/dialogs/plan-list';
import { pickerKeyAction } from '../src/renderer/ui/dialogs/picker-selection';
import type { PickerKey } from '../src/renderer/ui/dialogs/picker-selection';
import type { PlanSummary } from '../src/domain/plan/model';

const REPO = 'acme/app';

function summary(number: number, fields: Partial<PlanSummary> = {}): PlanSummary {
  return {
    repository: REPO, number, title: 'Plan ' + number, state: 'open', updatedAt: '2026-10-01T00:00:00Z',
    open: 3, total: 5, current: 2, levels: 3,
    ...fields,
  };
}

const numbers = (plans: readonly PlanSummary[]) => plans.map(plan => plan.number);

// ── Order ──

test('plans nobody opened come by their latest activity, the newest first', () => {
  /* Given */
  const plans = [
    summary(1, { updatedAt: '2026-10-01T00:00:00Z' }),
    summary(2, { updatedAt: '2026-10-03T00:00:00Z' }),
    summary(3, { updatedAt: '2026-10-02T00:00:00Z' }),
  ];

  /* When */
  const ordered = orderPlans(plans, []);

  /* Then */
  assert.deepEqual(numbers(ordered), [2, 3, 1]);
});

test('plans opened recently come first, the latest opened first, ahead of newer activity', () => {
  /* Given */
  const plans = [
    summary(1, { updatedAt: '2026-10-01T00:00:00Z' }),
    summary(2, { updatedAt: '2026-10-09T00:00:00Z' }),
    summary(3, { updatedAt: '2026-10-02T00:00:00Z' }),
    summary(4, { updatedAt: '2026-10-05T00:00:00Z' }),
  ];

  /* When */
  const ordered = orderPlans(plans, [REPO + '#3', REPO + '#1']);

  /* Then */
  assert.deepEqual(numbers(ordered), [3, 1, 2, 4]);
});

test('a recent plan that is no longer listed changes nothing', () => {
  /* Given */
  const plans = [summary(1, { updatedAt: '2026-10-01T00:00:00Z' }), summary(2, { updatedAt: '2026-10-02T00:00:00Z' })];

  /* When */
  const ordered = orderPlans(plans, [REPO + '#99']);

  /* Then */
  assert.deepEqual(numbers(ordered), [2, 1]);
});

// ── The filter ──

test('the filter matches words of a plan’s title, ignoring case', () => {
  /* Given */
  const plans = [summary(121, { title: 'Plan tab — an epic as a flow diagram' }), summary(112, { title: 'Image compare' })];

  /* When */
  const found = filterPlans(plans, 'FLOW plan');

  /* Then */
  assert.deepEqual(numbers(found), [121]);
});

test('the filter matches a plan’s #number, with or without the #', () => {
  /* Given */
  const plans = [summary(121), summary(112), summary(70)];

  /* When */
  const hashed = filterPlans(plans, '#12');
  const bare = filterPlans(plans, '70');

  /* Then */
  assert.deepEqual(numbers(hashed), [121]);
  assert.deepEqual(numbers(bare), [70]);
});

test('an empty filter keeps every plan, in order', () => {
  /* Given */
  const plans = [summary(2), summary(1)];

  /* When */
  const found = filterPlans(plans, '   ');

  /* Then */
  assert.deepEqual(numbers(found), [2, 1]);
});

// ── A row ──

test('a row says the level it is on and how much is closed', () => {
  /* Given */
  const plan = summary(121, { current: 1, levels: 3, open: 5, total: 5 });

  /* When */
  const level = planLevelLabel(plan);
  const closed = planClosedLabel(plan);

  /* Then */
  assert.equal(level, 'Level 1 of 3');
  assert.equal(closed, '0 / 5 closed');
});

test('a plan with no open level says Cleared, and its bar is full', () => {
  /* Given */
  const plan = summary(70, { current: null, levels: 2, open: 0, total: 8 });

  /* When */
  const level = planLevelLabel(plan);
  const segments = planLevelSegments(plan);

  /* Then */
  assert.equal(level, 'Cleared');
  assert.deepEqual(segments, ['cleared', 'cleared']);
});

test('the bar has one segment per level: cleared above the current one, locked below it', () => {
  /* Given */
  const plan = summary(5, { current: 2, levels: 4 });

  /* When */
  const segments = planLevelSegments(plan);

  /* Then */
  assert.deepEqual(segments, ['cleared', 'current', 'locked', 'locked']);
});

// ── The keys ──

function key(name: string, fields: Partial<PickerKey> = {}): PickerKey {
  return { key: name, shiftKey: false, caretAtStart: true, caretAtEnd: true, ...fields };
}

test('→ on a project that can have plans opens them; on one that cannot it is the input’s', () => {
  /* When */
  const can = pickerKeyAction('projects', key('ArrowRight'), true);
  const cannot = pickerKeyAction('projects', key('ArrowRight'), false);

  /* Then */
  assert.equal(can, 'into-plans');
  assert.equal(cannot, null);
});

test('→ in the middle of typed text moves the caret instead', () => {
  /* When */
  const action = pickerKeyAction('projects', key('ArrowRight', { caretAtEnd: false }), true);

  /* Then */
  assert.equal(action, null);
});

test('Tab opens a project’s plans, and Shift-Tab goes back from them', () => {
  /* When */
  const into = pickerKeyAction('projects', key('Tab'), true);
  const back = pickerKeyAction('plans', key('Tab', { shiftKey: true }), true);

  /* Then */
  assert.equal(into, 'into-plans');
  assert.equal(back, 'back-to-projects');
});

test('a Tab with nowhere to go is swallowed, so focus stays in the filter', () => {
  /* When */
  const noPlans = pickerKeyAction('projects', key('Tab'), false);
  const inPlans = pickerKeyAction('plans', key('Tab'), true);
  const shiftOnProjects = pickerKeyAction('projects', key('Tab', { shiftKey: true }), true);

  /* Then */
  assert.equal(noPlans, 'swallow');
  assert.equal(inPlans, 'swallow');
  assert.equal(shiftOnProjects, 'swallow');
});

test('← goes back to the projects with the caret at the start, and only from the plans', () => {
  /* When */
  const back = pickerKeyAction('plans', key('ArrowLeft'), false);
  const typed = pickerKeyAction('plans', key('ArrowLeft', { caretAtStart: false }), false);
  const onProjects = pickerKeyAction('projects', key('ArrowLeft'), true);

  /* Then */
  assert.equal(back, 'back-to-projects');
  assert.equal(typed, null);
  assert.equal(onProjects, null);
});

test('the arrows move and Enter opens, in either list', () => {
  /* When */
  const actions = (['projects', 'plans'] as const).flatMap(mode => [
    pickerKeyAction(mode, key('ArrowDown'), false),
    pickerKeyAction(mode, key('ArrowUp'), false),
    pickerKeyAction(mode, key('Enter'), false),
    pickerKeyAction(mode, key('a'), false),
  ]);

  /* Then */
  assert.deepEqual(actions, ['down', 'up', 'open', null, 'down', 'up', 'open', null]);
});
