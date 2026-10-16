import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { visibleUpdate } from '../src/renderer/state/update-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { UpdateNotice } from '../src/domain/update/release';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const notice = (version: string, installable = true): UpdateNotice => ({
  version, pageUrl: `https://example.com/v${version}`, installable,
});

// ── Status line ──

test('status: the running count is what the last load counted', () => {
  const counted = run(initialRendererState(), { type: 'runningCounted', running: 2 });
  assert.strictEqual(counted.status.running, 2);
  assert.strictEqual(run(counted, { type: 'runningCounted', running: 2 }), counted);
});

test('status: a message replaces the last, and an empty one clears it', () => {
  const progress = run(initialRendererState(), { type: 'statusUpdate', text: 'Indexing…', kind: 'active' });
  assert.deepStrictEqual(progress.status.activity, { text: 'Indexing…', done: false });

  const done = run(progress, { type: 'statusUpdate', text: 'Indexed 3', kind: 'done' });
  assert.deepStrictEqual(done.status.activity, { text: 'Indexed 3', done: true });

  const cleared = run(done, { type: 'statusUpdate', text: '', kind: 'done' });
  assert.deepStrictEqual(cleared.status.activity, { text: '', done: false });
});

test('status: only a done message expires; a newer one survives a stale linger', () => {
  const done = run(initialRendererState(), { type: 'statusUpdate', text: 'Indexed 3', kind: 'done' });
  assert.strictEqual(run(done, { type: 'statusActivityExpired' }).status.activity.text, '');

  const replaced = run(done, { type: 'statusUpdate', text: 'Indexing…', kind: 'active' });
  assert.strictEqual(run(replaced, { type: 'statusActivityExpired' }), replaced);
});

// ── Update notice ──

test('update: a check or a push puts the notice up; a null check takes it down', () => {
  const pushed = run(initialRendererState(), { type: 'updateAvailable', update: notice('9.1.0') });
  assert.strictEqual(visibleUpdate(pushed.update)?.version, '9.1.0');
  const checked = run(pushed, { type: 'updateChecked', update: null });
  assert.strictEqual(visibleUpdate(checked.update), null);
});

test('update: dismissing hides that version only', () => {
  const dismissed = run(initialRendererState(),
    { type: 'updateChecked', update: notice('9.1.0') },
    { type: 'updateDismissed', version: '9.1.0' });
  assert.strictEqual(visibleUpdate(dismissed.update), null);

  const same = run(dismissed, { type: 'updateAvailable', update: notice('9.1.0') });
  assert.strictEqual(visibleUpdate(same.update), null);

  const newer = run(same, { type: 'updateAvailable', update: notice('9.2.0') });
  assert.strictEqual(visibleUpdate(newer.update)?.version, '9.2.0');
});

test('update: an install runs, fails into a retry, and a new notice forgets the failure', () => {
  const offered = run(initialRendererState(), { type: 'updateChecked', update: notice('9.1.0') });
  const installing = run(offered, { type: 'updateInstallStarted' });
  assert.deepStrictEqual([installing.update.installing, installing.update.failed], [true, false]);
  assert.strictEqual(run(installing, { type: 'updateInstallStarted' }), installing);

  const failed = run(installing, { type: 'updateInstallFailed' });
  assert.deepStrictEqual([failed.update.installing, failed.update.failed], [false, true]);

  // A retry keeps the failure on screen until it answers.
  const retrying = run(failed, { type: 'updateInstallStarted' });
  assert.deepStrictEqual([retrying.update.installing, retrying.update.failed], [true, true]);

  const renewed = run(failed, { type: 'updateAvailable', update: notice('9.2.0') });
  assert.strictEqual(renewed.update.failed, false);
});
