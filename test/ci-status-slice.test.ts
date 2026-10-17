import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chipDot, ciStatusReducer, hiddenChipsDot, initialCiStatusState, rekeyCiStatus,
} from '../src/renderer/state/ci-status-slice';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { activityCard } from '../src/renderer/ui/session-work/describe';
import type { Activity, SessionWorkItem } from '../src/domain/session-work/model';
import type { PullRequestStatusChange } from '../src/domain/session-work/status';

const change = (sessionId: string, prs: PullRequestStatusChange['prs'], needsYou = false): PullRequestStatusChange =>
  ({ sessionId, prs, needsYou });

test('a session\'s dots are kept as pushed, and dropped when nothing is known any more', () => {
  const pushed = change('s1', [{ number: 7, dot: 'red' }, { number: 9, dot: 'green' }], true);
  let state = ciStatusReducer(initialCiStatusState, { type: 'prStatusChanged', change: pushed });
  assert.deepEqual(state.bySession.s1, pushed);
  assert.equal(chipDot(state.bySession.s1, 7), 'red');
  assert.equal(chipDot(state.bySession.s1, 8), null, 'no dot for a PR the watch said nothing about');

  state = ciStatusReducer(state, { type: 'prStatusChanged', change: change('s1', []) });
  assert.equal(state.bySession.s1, undefined);
  assert.equal(ciStatusReducer(state, { type: 'prStatusChanged', change: change('s1', []) }), state);
});

test('the +N chip takes the worst dot of the PRs it hides', () => {
  const pushed = change('s1', [{ number: 1, dot: 'green' }, { number: 2, dot: 'amber' }, { number: 3, dot: 'red' }]);
  assert.equal(hiddenChipsDot(pushed, [1, 2]), 'amber');
  assert.equal(hiddenChipsDot(pushed, [1, 3, 2]), 'red');
  assert.equal(hiddenChipsDot(pushed, [1]), 'green');
  assert.equal(hiddenChipsDot(pushed, [4]), null);
  assert.equal(hiddenChipsDot(undefined, [1]), null);
});

test('a re-keyed session keeps its dots', () => {
  const state = ciStatusReducer(initialCiStatusState, { type: 'prStatusChanged', change: change('s1', [{ number: 7, dot: 'amber' }]) });
  const moved = rekeyCiStatus(state, 's1', 's2');
  assert.equal(moved.bySession.s1, undefined);
  assert.equal(chipDot(moved.bySession.s2, 7), 'amber');

  const root = rootReducer(
    rootReducer(initialRendererState(), { type: 'prStatusChanged', change: change('s1', [{ number: 7, dot: 'red' }]) }),
    { type: 'sessionForked', oldId: 's1', newId: 's2' });
  assert.equal(chipDot(root.ciStatus.bySession.s2, 7), 'red');
});

test('a check log is asked for once, and kept once it came', () => {
  const url = 'https://github.com/o/app/actions/runs/1/job/2';
  let state = ciStatusReducer(initialCiStatusState, { type: 'checkLogRequested', url });
  assert.deepEqual(state.checkLogs[url], { loading: true });
  assert.equal(ciStatusReducer(state, { type: 'checkLogRequested', url }), state);
  state = ciStatusReducer(state, { type: 'checkLogLoaded', url, text: 'boom' });
  assert.deepEqual(state.checkLogs[url], { loading: false, text: 'boom' });
});

// The activity card of an automatic Fix CI

const NOW = Date.parse('2026-06-10T14:00:00.000Z');

function item(activity: Activity): SessionWorkItem {
  const url = 'https://github.com/acme/api/pull/52';
  return {
    id: 'pr:' + url, kind: 'pr',
    pr: { number: 52, url, repository: 'acme/api', state: 'open', checks: [{ name: 'test', state: 'failing' }], closes: [] },
    location: null, diff: { kind: 'pull-request', repository: 'acme/api', number: 52 }, activity,
  };
}

const auto = (phase: Activity['phase'], extra: Partial<Activity> = {}): Activity =>
  ({ id: 'a1', action: 'fix-ci', phase, origin: 'auto', queuedAt: '2026-06-10T13:50:00.000Z', ...extra });

test('Claude fixing CI on its own says which attempt it is, in amber', () => {
  const card = activityCard(item(auto('sent', { attempt: 2, checkName: 'test', sentAt: '2026-06-10T13:58:00.000Z' })), NOW)!;
  assert.equal(card.tone, 'amber');
  assert.equal(card.title, 'Claude is fixing CI · attempt 2 of 2');
  assert.equal(card.detail, 'test failed · sent to the session · started 2m ago');
  assert.equal(activityCard(item(auto('queued', { attempt: 1 })), NOW)!.title, 'Queued: fix CI on #52 · attempt 1 of 2');
});

test('auto-fix giving up is red, and lists each attempt and what Claude pushed', () => {
  const card = activityCard(item(auto('gave-up', {
    checkName: 'test',
    attempts: [{ attempt: 1, failedOn: 'aaaaaaa111', pushed: 'bbbbbbb222' }, { attempt: 2, failedOn: 'bbbbbbb222', pushed: null }],
  })), NOW)!;
  assert.equal(card.tone, 'red');
  assert.equal(card.title, 'Still failing after 2 automatic fixes');
  assert.match(card.detail, /^test still fails\./);
  assert.deepEqual(card.lines, [
    'Attempt 1 · failed on aaaaaaa · pushed bbbbbbb',
    'Attempt 2 · failed on bbbbbbb · nothing pushed',
  ]);
});
