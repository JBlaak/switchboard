import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemButtons } from '../src/renderer/ui/session-work/describe';
import type { Activity, SessionWorkItem } from '../src/domain/session-work/model';

const URL = 'https://github.com/acme/api/pull/1320';

function failingPr(activity: Activity): SessionWorkItem {
  return {
    id: 'pr:' + URL,
    kind: 'pr',
    pr: {
      number: 1320, url: URL, repository: 'acme/api', state: 'open', baseRef: 'main', headRef: 'fix/login-loop',
      checks: [{ name: 'test', state: 'failing', url: URL + '/checks' }], behindBy: 0, mergeable: 'mergeable', closes: [],
    },
    location: { worktree: '/w/api', branch: 'fix/login-loop', fromSubagent: false },
    diff: { kind: 'local', worktree: '/w/api', base: 'origin/main', head: 'fix/login-loop' },
    activity,
  };
}

test('once auto-fix gave up, a manual Fix CI is still offered and can be pressed', () => {
  /* Given */
  const gaveUp: Activity = {
    id: 'gave-1', action: 'fix-ci', phase: 'gave-up', origin: 'auto', checkName: 'test',
    attempts: [
      { attempt: 1, failedOn: 'aaaaaaa111', pushed: 'bbbbbbb222' },
      { attempt: 2, failedOn: 'bbbbbbb222', pushed: 'c0ffee1234' },
    ],
    queuedAt: '2026-06-10T13:50:00.000Z',
  };

  /* When */
  const buttons = itemButtons(failingPr(gaveUp), { gh: 'ok', running: true, pending: null });

  /* Then */
  const fixCi = buttons.find(button => button.id === 'fix-ci');
  assert.ok(fixCi, 'Fix CI is offered');
  assert.equal(fixCi.disabled, null);
});
