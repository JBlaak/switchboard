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

const pushedS1 = change('s1', [{ number: 7, dot: 'red' }, { number: 9, dot: 'green' }], true);
const pushed = (c: PullRequestStatusChange) => ciStatusReducer(initialCiStatusState, { type: 'prStatusChanged', change: c });

test('a session\'s dots are kept as pushed', () => {
  /* When */
  const state = pushed(pushedS1);

  /* Then */
  assert.deepEqual(state.bySession.s1, pushedS1);
  assert.equal(chipDot(state.bySession.s1, 7), 'red');
  assert.equal(chipDot(state.bySession.s1, 8), null, 'no dot for a PR the watch said nothing about');
});

test('a session\'s dots are dropped when nothing is known any more', () => {
  /* Given */
  const state = pushed(pushedS1);

  /* When */
  const emptied = ciStatusReducer(state, { type: 'prStatusChanged', change: change('s1', []) });

  /* Then */
  assert.equal(emptied.bySession.s1, undefined);
});

test('pushing nothing for a session that has no dots leaves the state as it was', () => {
  /* Given */
  const emptied = ciStatusReducer(pushed(pushedS1), { type: 'prStatusChanged', change: change('s1', []) });

  /* When */
  const again = ciStatusReducer(emptied, { type: 'prStatusChanged', change: change('s1', []) });

  /* Then */
  assert.equal(again, emptied);
});

test('the +N chip takes the worst dot of the PRs it hides', () => {
  /* Given */
  const prs = change('s1', [{ number: 1, dot: 'green' }, { number: 2, dot: 'amber' }, { number: 3, dot: 'red' }]);

  /* When */
  const amberAndGreen = hiddenChipsDot(prs, [1, 2]);
  const allThree = hiddenChipsDot(prs, [1, 3, 2]);
  const greenOnly = hiddenChipsDot(prs, [1]);
  const unknownPr = hiddenChipsDot(prs, [4]);
  const unknownSession = hiddenChipsDot(undefined, [1]);

  /* Then */
  assert.equal(amberAndGreen, 'amber');
  assert.equal(allThree, 'red');
  assert.equal(greenOnly, 'green');
  assert.equal(unknownPr, null);
  assert.equal(unknownSession, null);
});

test('a re-keyed session keeps its dots', () => {
  /* Given */
  const state = pushed(change('s1', [{ number: 7, dot: 'amber' }]));

  /* When */
  const moved = rekeyCiStatus(state, 's1', 's2');

  /* Then */
  assert.equal(moved.bySession.s1, undefined);
  assert.equal(chipDot(moved.bySession.s2, 7), 'amber');
});

test('a forked session keeps its dots in the root state', () => {
  /* Given */
  const state = rootReducer(initialRendererState(), { type: 'prStatusChanged', change: change('s1', [{ number: 7, dot: 'red' }]) });

  /* When */
  const root = rootReducer(state, { type: 'sessionForked', oldId: 's1', newId: 's2' });

  /* Then */
  assert.equal(chipDot(root.ciStatus.bySession.s2, 7), 'red');
});

const LOG_URL = 'https://github.com/o/app/actions/runs/1/job/2';

test('a check log that is asked for is loading', () => {
  /* When */
  const state = ciStatusReducer(initialCiStatusState, { type: 'checkLogRequested', url: LOG_URL });

  /* Then */
  assert.deepEqual(state.checkLogs[LOG_URL], { loading: true });
});

test('a check log is asked for once', () => {
  /* Given */
  const state = ciStatusReducer(initialCiStatusState, { type: 'checkLogRequested', url: LOG_URL });

  /* When */
  const again = ciStatusReducer(state, { type: 'checkLogRequested', url: LOG_URL });

  /* Then */
  assert.equal(again, state);
});

test('a check log is kept once it came', () => {
  /* Given */
  const state = ciStatusReducer(initialCiStatusState, { type: 'checkLogRequested', url: LOG_URL });

  /* When */
  const loaded = ciStatusReducer(state, { type: 'checkLogLoaded', url: LOG_URL, text: 'boom' });

  /* Then */
  assert.deepEqual(loaded.checkLogs[LOG_URL], { loading: false, text: 'boom' });
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
  /* Given */
  const sent = item(auto('sent', { attempt: 2, checkName: 'test', sentAt: '2026-06-10T13:58:00.000Z' }));

  /* When */
  const card = activityCard(sent, NOW)!;

  /* Then */
  assert.equal(card.tone, 'amber');
  assert.equal(card.title, 'Claude is fixing CI · attempt 2 of 2');
  assert.equal(card.detail, 'test failed · sent to the session · started 2m ago');
});

test('a queued automatic fix says which attempt it will be', () => {
  /* When */
  const card = activityCard(item(auto('queued', { attempt: 1 })), NOW)!;

  /* Then */
  assert.equal(card.title, 'Queued: fix CI on #52 · attempt 1 of 2');
});

test('auto-fix giving up is red, and lists each attempt and what Claude pushed', () => {
  /* Given */
  const gaveUp = item(auto('gave-up', {
    checkName: 'test',
    attempts: [{ attempt: 1, failedOn: 'aaaaaaa111', pushed: 'bbbbbbb222' }, { attempt: 2, failedOn: 'bbbbbbb222', pushed: null }],
  }));

  /* When */
  const card = activityCard(gaveUp, NOW)!;

  /* Then */
  assert.equal(card.tone, 'red');
  assert.equal(card.title, 'Still failing after 2 automatic fixes');
  assert.match(card.detail, /^test still fails\./);
  assert.deepEqual(card.lines, [
    'Attempt 1 · failed on aaaaaaa · pushed bbbbbbb',
    'Attempt 2 · failed on bbbbbbb · nothing pushed',
  ]);
});
