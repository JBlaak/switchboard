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

type Steps = ReturnType<typeof states>;

test('ship steps are labelled in order', () => {
  /* When */
  const steps = shipSteps(pr(), null);

  /* Then */
  assert.deepEqual(steps.map((s) => [s.id, s.label]), [
    ['rebase', 'Rebased'], ['ci', 'Waiting for CI'], ['merge', 'Merge'], ['cleanup', 'Clean up'],
  ]);
});

test('ship steps before anything is sent show what is already true', () => {
  /* Given */
  const cases: [PullRequestStatus, Activity | null, Steps][] = [
    [pr({ behindBy: 3 }), null, ['todo', 'todo', 'todo', 'todo']],
    [pr({ checks: [check('ci', 'passing')] }), null, ['done', 'done', 'todo', 'todo']],
    // A queued Ship it has not started.
    [pr({ behindBy: 3 }), activity('ship', 'queued'), ['todo', 'todo', 'todo', 'todo']],
  ];

  for (const [status, act, expected] of cases) {
    /* When */
    const steps = shipSteps(status, act);

    /* Then */
    assert.deepEqual(states(steps), expected);
  }
});

test('ship steps follow the polled state while Claude ships', () => {
  /* Given */
  const shipping = activity('ship', 'sent');
  const cases: [PullRequestStatus, Activity, Steps][] = [
    [pr({ behindBy: 2 }), shipping, ['running', 'todo', 'todo', 'todo']],
    [pr({ behindBy: 0, mergeable: 'conflicting' }), shipping, ['running', 'todo', 'todo', 'todo']],
    [pr({ checks: [check('ci', 'pending')] }), shipping, ['done', 'running', 'todo', 'todo']],
    // A failing check is being fixed as part of shipping.
    [pr({ checks: [check('ci', 'failing')] }), shipping, ['done', 'running', 'todo', 'todo']],
    [pr({ checks: [check('ci', 'passing'), check('x', 'skipped')] }), shipping, ['done', 'done', 'running', 'todo']],
    [pr({ state: 'merged' }), shipping, ['done', 'done', 'done', 'running']],
    [pr({ state: 'merged' }), activity('ship', 'done'), ['done', 'done', 'done', 'done']],
  ];

  for (const [status, act, expected] of cases) {
    /* When */
    const steps = shipSteps(status, act);

    /* Then */
    assert.deepEqual(states(steps), expected);
  }
});

test('a failing check nobody is fixing, or a ship Claude gave up on, fails its step', () => {
  /* Given */
  const gaveUp = activity('ship', 'gave-up');
  const cases: [PullRequestStatus, Activity | null, Steps][] = [
    [pr({ checks: [check('ci', 'failing')] }), null, ['done', 'failed', 'todo', 'todo']],
    [pr({ checks: [check('ci', 'failing')] }), gaveUp, ['done', 'failed', 'todo', 'todo']],
    [pr({ behindBy: 1 }), gaveUp, ['failed', 'todo', 'todo', 'todo']],
  ];

  for (const [status, act, expected] of cases) {
    /* When */
    const steps = shipSteps(status, act);

    /* Then */
    assert.deepEqual(states(steps), expected);
  }
});

test('a PR closed without merging fails the merge step', () => {
  /* Given */
  const closed = pr({ state: 'closed', checks: [check('ci', 'passing')] });

  /* When */
  const steps = shipSteps(closed, null);

  /* Then */
  assert.deepEqual(states(steps), ['done', 'done', 'failed', 'todo']);
});

test('another action in flight does not count as shipping', () => {
  /* When */
  const steps = shipSteps(pr({ behindBy: 2 }), activity('rebase', 'sent'));

  /* Then */
  assert.deepEqual(states(steps), ['todo', 'todo', 'todo', 'todo']);
});

test('without gh nothing is known, so nothing is done', () => {
  /* Given */
  const bare: PullRequestStatus = { number: 7, url: 'https://github.com/owner/repo/pull/7', repository: REPO, closes: [] };

  /* When */
  const steps = shipSteps(bare, null);

  /* Then */
  assert.deepEqual(states(steps), ['todo', 'todo', 'todo', 'todo']);
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
  /* Given */
  const status = pr({ checks: [check('ci', 'passing'), check('lint', 'failing')] });

  /* When */
  const decision = autoFixDecision(status, []);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'lint', headSha: 'aaa', attempt: 1 });
});

test('nothing failing, nothing to do', () => {
  /* When */
  const decision = autoFixDecision(pr({ checks: [check('ci', 'pending')] }), []);

  /* Then */
  assert.deepEqual(decision, { action: 'skip' });
});

test('a check is not handed over again while an attempt on it is queued or with Claude', () => {
  /* Given */
  const cases: [PullRequestStatus, AutoFixEvent[]][] = [
    [pr({ checks: [check('ci', 'failing')] }), [inFlight('ci', 'aaa')]],
    // A manual Fix CI in flight also means it is in hand.
    [pr({ checks: [check('ci', 'failing')] }), [inFlight('ci', 'aaa', 'manual')]],
    // Even once Claude pushed and the new commit failed: the turn is not over yet.
    [pr({ checks: [check('ci', 'failing')], headSha: 'bbb' }), [inFlight('ci', 'aaa')]],
  ];

  for (const [status, history] of cases) {
    /* When */
    const decision = autoFixDecision(status, history);

    /* Then */
    assert.deepEqual(decision, { action: 'skip' });
  }
});

test('an attempt Claude finished without pushing is spent: the same commit failing is the next attempt', () => {
  /* Given */
  const failing = { checks: [check('ci', 'failing')] };

  /* When */
  const decision = autoFixDecision(pr(failing), [attempt('ci', 'aaa')]);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'ci', headSha: 'aaa', attempt: 2 });
});

test('two attempts on the same failing commit give the PR up', () => {
  /* Given */
  const failing = { checks: [check('ci', 'failing')] };

  /* When */
  const decision = autoFixDecision(pr(failing), [attempt('ci', 'aaa'), attempt('ci', 'aaa')]);

  /* Then */
  assert.deepEqual(decision, { action: 'give-up', checkName: 'ci', attempts: 2 });
});

test('a new commit that still fails is the next attempt', () => {
  /* Given */
  const failing = { checks: [check('ci', 'failing')] };

  /* When */
  const decision = autoFixDecision(pr({ ...failing, headSha: 'bbb' }), [attempt('ci', 'aaa')]);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'ci', headSha: 'bbb', attempt: 2 });
});

test('after two attempts on new commits that still fail, the PR is given up', () => {
  /* Given */
  const failing = { checks: [check('ci', 'failing')] };

  /* When */
  const decision = autoFixDecision(pr({ ...failing, headSha: 'ccc' }), [attempt('ci', 'aaa'), attempt('ci', 'bbb')]);

  /* Then */
  assert.deepEqual(decision, { action: 'give-up', checkName: 'ci', attempts: 2 });
});

test('a PR is given up on once', () => {
  /* Given */
  const failing = { checks: [check('ci', 'failing')], headSha: 'ccc' };
  const spent = [attempt('ci', 'aaa'), attempt('ci', 'bbb')];

  /* When */
  const decision = autoFixDecision(pr(failing), [...spent, gaveUp('ci')]);

  /* Then */
  assert.deepEqual(decision, { action: 'skip' });
});

test('a given-up PR is picked up again once the check has gone green', () => {
  /* Given */
  const failing = { checks: [check('ci', 'failing')], headSha: 'ccc' };
  const spent = [attempt('ci', 'aaa'), attempt('ci', 'bbb')];

  /* When */
  const decision = autoFixDecision(pr(failing), [...spent, gaveUp('ci'), passed('ci')]);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'ci', headSha: 'ccc', attempt: 1 });
});

test('manual attempts do not count towards the limit', () => {
  /* Given */
  const history = [attempt('ci', 'aaa'), attempt('ci', 'bbb', 'manual')];

  /* When */
  const decision = autoFixDecision(pr({ checks: [check('ci', 'failing')], headSha: 'ccc' }), history);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'ci', headSha: 'ccc', attempt: 2 });
});

test('a finished manual attempt does not hold auto-fix back on the commit it was for', () => {
  /* When */
  const decision = autoFixDecision(pr({ checks: [check('ci', 'failing')] }), [attempt('ci', 'aaa', 'manual')]);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'ci', headSha: 'aaa', attempt: 1 });
});

test('any number of manual attempts leaves auto-fix at attempt 1', () => {
  /* Given */
  const manyManual = [attempt('ci', 'aaa', 'manual'), attempt('ci', 'bbb', 'manual'), attempt('ci', 'ccc', 'manual')];

  /* When */
  const decision = autoFixDecision(pr({ checks: [check('ci', 'failing')], headSha: 'ddd' }), manyManual);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'ci', headSha: 'ddd', attempt: 1 });
});

test('the count is per check and per PR', () => {
  /* Given */
  const history = [attempt('ci', 'aaa'), attempt('ci', 'bbb'), attempt('lint', 'aaa', 'auto', 8)];
  const status = pr({ checks: [check('ci', 'failing'), check('lint', 'failing')], headSha: 'ccc' });

  /* When */
  const decision = autoFixDecision(status, history);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'lint', headSha: 'ccc', attempt: 1 });
});

test('the count resets when the check goes green', () => {
  /* Given */
  const history = [attempt('ci', 'aaa'), attempt('ci', 'bbb'), passed('ci')];

  /* When */
  const decision = autoFixDecision(pr({ checks: [check('ci', 'failing')], headSha: 'ddd' }), history);

  /* Then */
  assert.deepEqual(decision, { action: 'queue', checkName: 'ci', headSha: 'ddd', attempt: 1 });
});

test('merged, closed or unknown-head PRs are left alone', () => {
  /* Given */
  const cases = [
    pr({ state: 'merged', checks: [check('ci', 'failing')] }),
    pr({ state: 'closed', checks: [check('ci', 'failing')] }),
    pr({ headSha: undefined, checks: [check('ci', 'failing')] }),
  ];

  for (const status of cases) {
    /* When */
    const decision = autoFixDecision(status, []);

    /* Then */
    assert.deepEqual(decision, { action: 'skip' });
  }
});

const fixHistory = [attempt('ci', 'old'), passed('ci'), attempt('ci', 'aaa'), attempt('ci', 'bbb', 'manual'), attempt('ci', 'bbb')];

test('the attempts auto-fix gave up after, with what Claude pushed for each', () => {
  /* When */
  const attempts = autoFixAttempts(pr({ headSha: 'ccc' }), 'ci', fixHistory);

  /* Then */
  assert.deepEqual(attempts, [
    { attempt: 1, failedOn: 'aaa', pushed: 'bbb' },
    { attempt: 2, failedOn: 'bbb', pushed: 'ccc' },
  ]);
});

test('an attempt on the current head has pushed nothing yet', () => {
  /* When */
  const attempts = autoFixAttempts(pr({ headSha: 'bbb' }), 'ci', fixHistory);

  /* Then */
  assert.deepEqual(attempts[1], { attempt: 2, failedOn: 'bbb', pushed: null });
});

test('auto-fix attempts since the check last passed are a streak', () => {
  /* When */
  const streak = hasAutoFixStreak(pr(), 'ci', fixHistory);

  /* Then */
  assert.equal(streak, true);
});

test('a pass ends the auto-fix streak', () => {
  /* When */
  const streak = hasAutoFixStreak(pr(), 'ci', [...fixHistory, passed('ci')]);

  /* Then */
  assert.equal(streak, false);
});

test('a give-up alone is a streak', () => {
  /* When */
  const streak = hasAutoFixStreak(pr(), 'ci', [gaveUp('ci')]);

  /* Then */
  assert.equal(streak, true);
});

// statusDot

test('green when passing, amber when running, red when failing', () => {
  /* Given */
  const cases: [PullRequestStatus, string][] = [
    [pr({ checks: [check('ci', 'passing')] }), 'green'],
    [pr({ checks: [] }), 'green'],
    [pr({ checks: [check('ci', 'passing'), check('e2e', 'pending')] }), 'amber'],
    [pr({ checks: [check('ci', 'failing'), check('e2e', 'pending')] }), 'red'],
  ];

  for (const [status, expected] of cases) {
    /* When */
    const dot = statusDot(status, null);

    /* Then */
    assert.equal(dot, expected);
  }
});

test('amber while Claude works on it, even over a failing check; red once it gave up', () => {
  /* Given */
  const failing = pr({ checks: [check('ci', 'failing')] });
  const cases: [PullRequestStatus, Activity, string][] = [
    [failing, activity('fix-ci', 'queued', 'auto'), 'amber'],
    [failing, activity('fix-ci', 'sent', 'auto'), 'amber'],
    [failing, activity('fix-ci', 'gave-up', 'auto'), 'red'],
    [pr(), activity('fix-ci', 'done'), 'green'],
  ];

  for (const [status, act, expected] of cases) {
    /* When */
    const dot = statusDot(status, act);

    /* Then */
    assert.equal(dot, expected);
  }
});

const waiting = () => pr({ threads: [{ id: 't', path: 'a', line: 1, side: 'RIGHT', resolved: false, needsYou: true, comments: [] }] });

test('a thread waiting on you means the PR needs you', () => {
  /* When */
  const needs = needsYou(waiting(), null);

  /* Then */
  assert.equal(needs, true);
});

test('red once it needs you', () => {
  /* When */
  const dot = statusDot(waiting(), null);

  /* Then */
  assert.equal(dot, 'red');
});

test('a merged PR is merged, whatever its checks or activity say', () => {
  /* Given */
  const cases: [PullRequestStatus, Activity | null][] = [
    [pr({ state: 'merged', checks: [check('ci', 'failing')] }), null],
    [pr({ state: 'merged' }), activity('ship', 'gave-up')],
  ];

  for (const [status, act] of cases) {
    /* When */
    const dot = statusDot(status, act);

    /* Then */
    assert.equal(dot, 'merged');
  }
});

test('a closed PR is green', () => {
  /* Given */
  const status = pr({ state: 'closed' });

  /* When */
  const dot = statusDot(status, activity('ship', 'gave-up'));

  /* Then */
  assert.equal(dot, 'green');
});

test('the +N chip takes the worst of the PRs it hides', () => {
  /* Given */
  const cases: [Parameters<typeof worstStatusDot>[0], string | null][] = [
    [[], null],
    [['green', 'green'], 'green'],
    [['green', 'amber', 'green'], 'amber'],
    [['amber', 'red', 'green'], 'red'],
    [['merged', 'merged'], 'merged'],
    [['merged', 'green'], 'green'],
  ];

  for (const [dots, expected] of cases) {
    /* When */
    const worst = worstStatusDot(dots);

    /* Then */
    assert.equal(worst, expected);
  }
});
