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

const status = (text: string, kind: 'active' | 'done'): RendererEvent => ({ type: 'statusUpdate', text, kind });

// ── Status line ──

test('status: the running count is what the last load counted', () => {
  /* When */
  const counted = run(initialRendererState(), { type: 'runningCounted', running: 2 });

  /* Then */
  assert.strictEqual(counted.status.running, 2);
});

test('status: the same running count again leaves the state as it was', () => {
  /* Given */
  const counted = run(initialRendererState(), { type: 'runningCounted', running: 2 });

  /* When */
  const again = run(counted, { type: 'runningCounted', running: 2 });

  /* Then */
  assert.strictEqual(again, counted);
});

test('status: an active message shows as not done', () => {
  /* When */
  const progress = run(initialRendererState(), status('Indexing…', 'active'));

  /* Then */
  assert.deepStrictEqual(progress.status.activity, { text: 'Indexing…', done: false });
});

test('status: a message replaces the last', () => {
  /* Given */
  const progress = run(initialRendererState(), status('Indexing…', 'active'));

  /* When */
  const done = run(progress, status('Indexed 3', 'done'));

  /* Then */
  assert.deepStrictEqual(done.status.activity, { text: 'Indexed 3', done: true });
});

test('status: an empty message clears the last', () => {
  /* Given */
  const done = run(initialRendererState(), status('Indexing…', 'active'), status('Indexed 3', 'done'));

  /* When */
  const cleared = run(done, status('', 'done'));

  /* Then */
  assert.deepStrictEqual(cleared.status.activity, { text: '', done: false });
});

test('status: a done message expires', () => {
  /* Given */
  const done = run(initialRendererState(), status('Indexed 3', 'done'));

  /* When */
  const expired = run(done, { type: 'statusActivityExpired' });

  /* Then */
  assert.strictEqual(expired.status.activity.text, '');
});

test('status: a newer message survives a stale linger', () => {
  /* Given */
  const replaced = run(initialRendererState(), status('Indexed 3', 'done'), status('Indexing…', 'active'));

  /* When */
  const next = run(replaced, { type: 'statusActivityExpired' });

  /* Then */
  assert.strictEqual(next, replaced);
});

// ── Update notice ──

test('update: a push puts the notice up', () => {
  /* When */
  const pushed = run(initialRendererState(), { type: 'updateAvailable', update: notice('9.1.0') });

  /* Then */
  assert.strictEqual(visibleUpdate(pushed.update)?.version, '9.1.0');
});

test('update: a null check takes the notice down', () => {
  /* Given */
  const pushed = run(initialRendererState(), { type: 'updateAvailable', update: notice('9.1.0') });

  /* When */
  const checked = run(pushed, { type: 'updateChecked', update: null });

  /* Then */
  assert.strictEqual(visibleUpdate(checked.update), null);
});

test('update: dismissing hides the notice', () => {
  /* Given */
  const offered = run(initialRendererState(), { type: 'updateChecked', update: notice('9.1.0') });

  /* When */
  const dismissed = run(offered, { type: 'updateDismissed', version: '9.1.0' });

  /* Then */
  assert.strictEqual(visibleUpdate(dismissed.update), null);
});

test('update: a dismissed version stays hidden when pushed again', () => {
  /* Given */
  const dismissed = run(initialRendererState(),
    { type: 'updateChecked', update: notice('9.1.0') },
    { type: 'updateDismissed', version: '9.1.0' });

  /* When */
  const same = run(dismissed, { type: 'updateAvailable', update: notice('9.1.0') });

  /* Then */
  assert.strictEqual(visibleUpdate(same.update), null);
});

test('update: dismissing hides that version only', () => {
  /* Given */
  const same = run(initialRendererState(),
    { type: 'updateChecked', update: notice('9.1.0') },
    { type: 'updateDismissed', version: '9.1.0' },
    { type: 'updateAvailable', update: notice('9.1.0') });

  /* When */
  const newer = run(same, { type: 'updateAvailable', update: notice('9.2.0') });

  /* Then */
  assert.strictEqual(visibleUpdate(newer.update)?.version, '9.2.0');
});

const offered = () => run(initialRendererState(), { type: 'updateChecked', update: notice('9.1.0') });
const failedInstall = () => run(offered(), { type: 'updateInstallStarted' }, { type: 'updateInstallFailed' });

test('update: an install runs', () => {
  /* When */
  const installing = run(offered(), { type: 'updateInstallStarted' });

  /* Then */
  assert.deepStrictEqual([installing.update.installing, installing.update.failed], [true, false]);
});

test('update: starting an install that is running leaves the state as it was', () => {
  /* Given */
  const installing = run(offered(), { type: 'updateInstallStarted' });

  /* When */
  const again = run(installing, { type: 'updateInstallStarted' });

  /* Then */
  assert.strictEqual(again, installing);
});

test('update: an install fails into a retry', () => {
  /* Given */
  const installing = run(offered(), { type: 'updateInstallStarted' });

  /* When */
  const failed = run(installing, { type: 'updateInstallFailed' });

  /* Then */
  assert.deepStrictEqual([failed.update.installing, failed.update.failed], [false, true]);
});

test('update: a retry keeps the failure on screen until it answers', () => {
  /* Given */
  const failed = failedInstall();

  /* When */
  const retrying = run(failed, { type: 'updateInstallStarted' });

  /* Then */
  assert.deepStrictEqual([retrying.update.installing, retrying.update.failed], [true, true]);
});

test('update: a new notice forgets the failure', () => {
  /* Given */
  const failed = failedInstall();

  /* When */
  const renewed = run(failed, { type: 'updateAvailable', update: notice('9.2.0') });

  /* Then */
  assert.strictEqual(renewed.update.failed, false);
});
