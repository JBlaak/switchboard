import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoFixAttempts, autoFixDecision, hasAutoFixStreak, type AutoFixEvent } from '../src/domain/session-work/auto-fix';
import type { Activity, CheckRun, PullRequestStatus } from '../src/domain/session-work/model';
import { shipSteps } from '../src/domain/session-work/ship';
import { needsYou, statusDot, worstStatusDot } from '../src/domain/session-work/status';

const REPO = 'owner/repo';

function pr(more: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 7, url: `https://github.com/${REPO}/pull/7`, repository: REPO, closes: [],
    state: 'open', behindBy: 0, mergeable: 'mergeable', headSha: 'aaa', checks: [], ...more,
  };
}

const check = (name: string, state: CheckRun['state']): CheckRun => ({ name, state });

function activity(action: Activity['action'], phase: Activity['phase'], origin: Activity['origin'] = 'manual'): Activity {
  return { id: 'a1', action, phase, origin, queuedAt: '2026-01-01T00:00:00Z' };
}

const states = (steps: ReturnType<typeof shipSteps>) => steps.map((step) => step.state);

// shipSteps

test('ship steps are labelled in order', () => {
  assert.deepEqual(shipSteps(pr(), null).map((s) => [s.id, s.label]), [
    ['rebase', 'Rebased'], ['ci', 'Waiting for CI'], ['merge', 'Merge'], ['cleanup', 'Clean up'],
  ]);
});

test('ship steps before anything is sent show what is already true', () => {
  assert.deepEqual(states(shipSteps(pr({ behindBy: 3 }), null)), ['todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(shipSteps(pr({ checks: [check('ci', 'passing')] }), null)), ['done', 'done', 'todo', 'todo']);
  // A queued Ship it has not started.
  assert.deepEqual(states(shipSteps(pr({ behindBy: 3 }), activity('ship', 'queued'))), ['todo', 'todo', 'todo', 'todo']);
});

test('ship steps follow the polled state while Claude ships', () => {
  const shipping = activity('ship', 'sent');
  assert.deepEqual(states(shipSteps(pr({ behindBy: 2 }), shipping)), ['running', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(shipSteps(pr({ behindBy: 0, mergeable: 'conflicting' }), shipping)), ['running', 'todo', 'todo', 'todo']);
  assert.deepEqual(states(shipSteps(pr({ checks: [check('ci', 'pending')] }), shipping)), ['done', 'running', 'todo', 'todo']);
  // A failing check is being fixed as part of shipping.
  assert.deepEqual(states(shipSteps(pr({ checks: [check('ci', 'failing')] }), shipping)), ['done', 'running', 'todo', 'todo']);
  assert.deepEqual(states(shipSteps(pr({ checks: [check('ci', 'passing'), check('x', 'skipped')] }), shipping)), ['done', 'done', 'running', 'todo']);
  assert.deepEqual(states(shipSteps(pr({ state: 'merged' }), shipping)), ['done', 'done', 'done', 'running']);
  assert.deepEqual(states(shipSteps(pr({ state: 'merged' }), activity('ship', 'done'))), ['done', 'done', 'done', 'done']);
});

test('a failing check nobody is fixing, or a ship Claude gave up on, fails its step', () => {
  assert.deepEqual(states(shipSteps(pr({ checks: [check('ci', 'failing')] }), null)), ['done', 'failed', 'todo', 'todo']);
  const gaveUp = activity('ship', 'gave-up');
  assert.deepEqual(states(shipSteps(pr({ checks: [check('ci', 'failing')] }), gaveUp)), ['done', 'failed', 'todo', 'todo']);
  assert.deepEqual(states(shipSteps(pr({ behindBy: 1 }), gaveUp)), ['failed', 'todo', 'todo', 'todo']);
});

test('a PR closed without merging fails the merge step', () => {
  assert.deepEqual(states(shipSteps(pr({ state: 'closed', checks: [check('ci', 'passing')] }), null)), ['done', 'done', 'failed', 'todo']);
});

test('another action in flight does not count as shipping', () => {
  assert.deepEqual(states(shipSteps(pr({ behindBy: 2 }), activity('rebase', 'sent'))), ['todo', 'todo', 'todo', 'todo']);
});

test('without gh nothing is known, so nothing is done', () => {
  const bare: PullRequestStatus = { number: 7, url: 'https://github.com/owner/repo/pull/7', repository: REPO, closes: [] };
  assert.deepEqual(states(shipSteps(bare, null)), ['todo', 'todo', 'todo', 'todo']);
});

// autoFixDecision

const attempt = (
  checkName: string, headSha: string, origin: 'auto' | 'manual' = 'auto', number = 7, inFlight = false,
): AutoFixEvent => ({ kind: 'attempt', repository: REPO, number, checkName, headSha, origin, inFlight });
const inFlight = (checkName: string, headSha: string, origin: 'auto' | 'manual' = 'auto'): AutoFixEvent =>
  attempt(checkName, headSha, origin, 7, true);
const passed = (checkName: string): AutoFixEvent => ({ kind: 'passed', repository: REPO, number: 7, checkName });
const gaveUp = (checkName: string): AutoFixEvent => ({ kind: 'gave-up', repository: REPO, number: 7, checkName });

test('a failing check is queued as attempt 1', () => {
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'passing'), check('lint', 'failing')] }), []),
    { action: 'queue', checkName: 'lint', headSha: 'aaa', attempt: 1 });
});

test('nothing failing, nothing to do', () => {
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'pending')] }), []), { action: 'skip' });
});

test('a check is not handed over again while an attempt on it is queued or with Claude', () => {
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'failing')] }), [inFlight('ci', 'aaa')]), { action: 'skip' });
  // A manual Fix CI in flight also means it is in hand.
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'failing')] }), [inFlight('ci', 'aaa', 'manual')]), { action: 'skip' });
  // Even once Claude pushed and the new commit failed: the turn is not over yet.
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'failing')], headSha: 'bbb' }), [inFlight('ci', 'aaa')]),
    { action: 'skip' });
});

test('an attempt Claude finished without pushing is spent: the same commit failing is the next attempt', () => {
  const failing = { checks: [check('ci', 'failing')] };
  assert.deepEqual(autoFixDecision(pr(failing), [attempt('ci', 'aaa')]),
    { action: 'queue', checkName: 'ci', headSha: 'aaa', attempt: 2 });
  assert.deepEqual(autoFixDecision(pr(failing), [attempt('ci', 'aaa'), attempt('ci', 'aaa')]),
    { action: 'give-up', checkName: 'ci', attempts: 2 });
});

test('a new commit that still fails is the next attempt, and after two the PR is given up', () => {
  const failing = { checks: [check('ci', 'failing')] };
  assert.deepEqual(autoFixDecision(pr({ ...failing, headSha: 'bbb' }), [attempt('ci', 'aaa')]),
    { action: 'queue', checkName: 'ci', headSha: 'bbb', attempt: 2 });
  assert.deepEqual(autoFixDecision(pr({ ...failing, headSha: 'ccc' }), [attempt('ci', 'aaa'), attempt('ci', 'bbb')]),
    { action: 'give-up', checkName: 'ci', attempts: 2 });
});

test('a PR is given up on once, until the check goes green', () => {
  const failing = { checks: [check('ci', 'failing')], headSha: 'ccc' };
  const spent = [attempt('ci', 'aaa'), attempt('ci', 'bbb')];
  assert.deepEqual(autoFixDecision(pr(failing), [...spent, gaveUp('ci')]), { action: 'skip' });
  assert.deepEqual(autoFixDecision(pr(failing), [...spent, gaveUp('ci'), passed('ci')]),
    { action: 'queue', checkName: 'ci', headSha: 'ccc', attempt: 1 });
});

test('manual attempts do not count towards the limit', () => {
  const history = [attempt('ci', 'aaa'), attempt('ci', 'bbb', 'manual')];
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'failing')], headSha: 'ccc' }), history),
    { action: 'queue', checkName: 'ci', headSha: 'ccc', attempt: 2 });
  // Nor does a finished one hold auto-fix back on the commit it was for.
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'failing')] }), [attempt('ci', 'aaa', 'manual')]),
    { action: 'queue', checkName: 'ci', headSha: 'aaa', attempt: 1 });
  const manyManual = [attempt('ci', 'aaa', 'manual'), attempt('ci', 'bbb', 'manual'), attempt('ci', 'ccc', 'manual')];
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'failing')], headSha: 'ddd' }), manyManual),
    { action: 'queue', checkName: 'ci', headSha: 'ddd', attempt: 1 });
});

test('the count is per check and per PR', () => {
  const history = [attempt('ci', 'aaa'), attempt('ci', 'bbb'), attempt('lint', 'aaa', 'auto', 8)];
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'failing'), check('lint', 'failing')], headSha: 'ccc' }), history),
    { action: 'queue', checkName: 'lint', headSha: 'ccc', attempt: 1 });
});

test('the count resets when the check goes green', () => {
  const history = [attempt('ci', 'aaa'), attempt('ci', 'bbb'), passed('ci')];
  assert.deepEqual(autoFixDecision(pr({ checks: [check('ci', 'failing')], headSha: 'ddd' }), history),
    { action: 'queue', checkName: 'ci', headSha: 'ddd', attempt: 1 });
});

test('merged, closed or unknown-head PRs are left alone', () => {
  assert.deepEqual(autoFixDecision(pr({ state: 'merged', checks: [check('ci', 'failing')] }), []), { action: 'skip' });
  assert.deepEqual(autoFixDecision(pr({ state: 'closed', checks: [check('ci', 'failing')] }), []), { action: 'skip' });
  assert.deepEqual(autoFixDecision(pr({ headSha: undefined, checks: [check('ci', 'failing')] }), []), { action: 'skip' });
});

test('the attempts auto-fix gave up after, with what Claude pushed for each', () => {
  const history = [attempt('ci', 'old'), passed('ci'), attempt('ci', 'aaa'), attempt('ci', 'bbb', 'manual'), attempt('ci', 'bbb')];
  assert.deepEqual(autoFixAttempts(pr({ headSha: 'ccc' }), 'ci', history), [
    { attempt: 1, failedOn: 'aaa', pushed: 'bbb' },
    { attempt: 2, failedOn: 'bbb', pushed: 'ccc' },
  ]);
  assert.deepEqual(autoFixAttempts(pr({ headSha: 'bbb' }), 'ci', history)[1], { attempt: 2, failedOn: 'bbb', pushed: null });
  assert.equal(hasAutoFixStreak(pr(), 'ci', history), true);
  assert.equal(hasAutoFixStreak(pr(), 'ci', [...history, passed('ci')]), false);
  assert.equal(hasAutoFixStreak(pr(), 'ci', [gaveUp('ci')]), true);
});

// statusDot

test('green when passing, amber when running, red when failing', () => {
  assert.equal(statusDot(pr({ checks: [check('ci', 'passing')] }), null), 'green');
  assert.equal(statusDot(pr({ checks: [] }), null), 'green');
  assert.equal(statusDot(pr({ checks: [check('ci', 'passing'), check('e2e', 'pending')] }), null), 'amber');
  assert.equal(statusDot(pr({ checks: [check('ci', 'failing'), check('e2e', 'pending')] }), null), 'red');
});

test('amber while Claude works on it, even over a failing check; red once it needs you', () => {
  const failing = pr({ checks: [check('ci', 'failing')] });
  assert.equal(statusDot(failing, activity('fix-ci', 'queued', 'auto')), 'amber');
  assert.equal(statusDot(failing, activity('fix-ci', 'sent', 'auto')), 'amber');
  assert.equal(statusDot(failing, activity('fix-ci', 'gave-up', 'auto')), 'red');
  assert.equal(statusDot(pr(), activity('fix-ci', 'done')), 'green');
  const waiting = pr({ threads: [{ id: 't', path: 'a', line: 1, side: 'RIGHT', resolved: false, needsYou: true, comments: [] }] });
  assert.equal(needsYou(waiting, null), true);
  assert.equal(statusDot(waiting, null), 'red');
});

test('merged and closed PRs are green', () => {
  assert.equal(statusDot(pr({ state: 'merged', checks: [check('ci', 'failing')] }), null), 'green');
  assert.equal(statusDot(pr({ state: 'closed' }), activity('ship', 'gave-up')), 'green');
});

test('the +N chip takes the worst of the PRs it hides', () => {
  assert.equal(worstStatusDot([]), null);
  assert.equal(worstStatusDot(['green', 'green']), 'green');
  assert.equal(worstStatusDot(['green', 'amber', 'green']), 'amber');
  assert.equal(worstStatusDot(['amber', 'red', 'green']), 'red');
});
