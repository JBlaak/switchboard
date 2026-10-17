import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import {
  diffKey, diffToLoad, selectedDiff, steppedFilePath,
} from '../src/renderer/state/session-work-slice';
import { collapsedText, diffSummary, fileStatusPill } from '../src/renderer/ui/session-work/describe';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { FileDiff, SessionWorkItem, SessionWorkSnapshot } from '../src/domain/session-work/model';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const pr: SessionWorkItem = {
  id: 'pr:52',
  kind: 'pr',
  pr: { number: 52, url: 'u52', repository: 'acme/api', state: 'open', headSha: 'aaa', closes: [] },
  location: null,
  diff: { kind: 'pull-request', repository: 'acme/api', number: 52 },
  activity: null,
};
const dirty: SessionWorkItem = {
  id: 'dirty:/w',
  kind: 'dirty',
  location: { worktree: '/w', branch: 'main', fromSubagent: false },
  files: [{ path: 'a.ts', status: 'modified' }],
  activity: null,
  additions: 1,
  deletions: 1,
};
const issue: SessionWorkItem = { id: 'issue:#9', kind: 'issue', issue: { repository: '', number: 9 } };

function file(path: string, more: Partial<FileDiff> = {}): FileDiff {
  return { path, status: 'modified', additions: 1, deletions: 1, hunks: [], binary: false, ...more };
}
const FILES = [file('a.ts'), file('package-lock.json', { collapsedReason: 'lockfile', additions: 900 }), file('logo.png', { binary: true, additions: 0, deletions: 0 })];

function snapshot(items: SessionWorkItem[]): SessionWorkSnapshot {
  return { sessionId: 's1', repository: 'acme/api', items, footprint: { worktrees: 2, branches: 2 }, queued: 0, gh: 'ok', updatedAt: '2026-06-10T14:00:00.000Z' };
}

/** A page open on `items`, the first selected. */
function opened(items: SessionWorkItem[] = [pr, dirty]): RendererState {
  return run(initialRendererState('s1'),
    { type: 'sessionWorkOpened', sessionId: 's1', name: 'Fix login', at: 0 },
    { type: 'sessionWorkSnapshot', snapshot: snapshot(items) });
}

const page = (state: RendererState) => state.sessionWork.page!;
const requested = (itemId: string, key: string): RendererEvent => ({ type: 'sessionWorkDiffRequested', sessionId: 's1', itemId, key });
const loaded = (itemId: string, key: string, files = FILES, source: 'local' | 'github' = 'local'): RendererEvent =>
  ({ type: 'sessionWorkDiffLoaded', sessionId: 's1', itemId, key, diff: { files, source } });

test('diff: the selected item\'s diff is wanted until it is asked for', () => {
  const state = opened();
  assert.deepStrictEqual(diffToLoad(page(state)), { itemId: pr.id, key: diffKey(pr) });

  const asking = run(state, requested(pr.id, diffKey(pr)));
  assert.strictEqual(diffToLoad(page(asking)), null, 'on its way');
  assert.deepStrictEqual(selectedDiff(page(asking)), {
    key: diffKey(pr), phase: 'loading', files: [], source: null, error: null, expanded: [], focusedPath: null,
  });
  assert.strictEqual(run(asking, requested(pr.id, diffKey(pr))), asking, 'asking twice changes nothing');
});

test('diff: an issue has no diff, and nothing selected wants none', () => {
  assert.strictEqual(diffKey(issue), '');
  assert.strictEqual(diffToLoad(page(opened([issue]))), null);
});

test('diff: the answer fills it, with where it came from', () => {
  const state = run(opened(), requested(pr.id, diffKey(pr)), loaded(pr.id, diffKey(pr), FILES, 'github'));
  const diff = selectedDiff(page(state))!;
  assert.strictEqual(diff.phase, 'loaded');
  assert.strictEqual(diff.files, FILES);
  assert.strictEqual(diff.source, 'github');
  assert.strictEqual(diffToLoad(page(state)), null);
});

test('diff: an answer for an item that changed since, or was never asked for, is dropped', () => {
  const asking = run(opened(), requested(pr.id, 'old-key'));
  assert.strictEqual(run(asking, loaded(pr.id, 'older-key')), asking);
  assert.strictEqual(run(asking, loaded(dirty.id, diffKey(dirty))), asking);
});

test('diff: an error with no files is a failure; a failed request too', () => {
  const key = diffKey(pr);
  const asking = run(opened(), requested(pr.id, key));
  const failed = run(asking, {
    type: 'sessionWorkDiffLoaded', sessionId: 's1', itemId: pr.id, key,
    diff: { files: [], source: null, error: 'GitHub did not send the diff' },
  });
  assert.strictEqual(selectedDiff(page(failed))!.phase, 'failed');
  assert.strictEqual(selectedDiff(page(failed))!.error, 'GitHub did not send the diff');

  const thrown = run(asking, { type: 'sessionWorkDiffFailed', sessionId: 's1', itemId: pr.id, key, message: 'IPC gone' });
  assert.deepStrictEqual([selectedDiff(page(thrown))!.phase, selectedDiff(page(thrown))!.error], ['failed', 'IPC gone']);
  assert.strictEqual(diffToLoad(page(thrown)), null, 'not asked again until the item changes');
});

test('diff: a snapshot that changes the item asks again, keeping what is shown meanwhile', () => {
  const key = diffKey(pr);
  const shown = run(opened(), requested(pr.id, key), loaded(pr.id, key),
    { type: 'sessionWorkFileExpanded', itemId: pr.id, path: 'package-lock.json' });
  const pushed: SessionWorkItem = { ...pr, pr: { ...pr.pr, headSha: 'bbb' } } as SessionWorkItem;
  const changed = run(shown, { type: 'sessionWorkSnapshot', snapshot: snapshot([pushed, dirty]) });
  assert.deepStrictEqual(diffToLoad(page(changed)), { itemId: pr.id, key: diffKey(pushed) });
  assert.notStrictEqual(diffKey(pushed), key);

  const again = run(changed, requested(pr.id, diffKey(pushed)));
  const diff = selectedDiff(page(again))!;
  assert.strictEqual(diff.phase, 'loading');
  assert.strictEqual(diff.files, FILES, 'the old files stay up while the new ones load');
  assert.deepStrictEqual(diff.expanded, ['package-lock.json']);
});

test('diff: an activity or an error on the item is not a new diff', () => {
  const busy = { ...pr, activity: { id: 'a1', action: 'ship', phase: 'sent', origin: 'manual', queuedAt: 'x' }, error: 'e' } as SessionWorkItem;
  assert.strictEqual(diffKey(busy), diffKey(pr));
  const edited = { ...dirty, files: [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'untracked' }] } as SessionWorkItem;
  assert.notStrictEqual(diffKey(edited), diffKey(dirty));
});

test('diff: diffs of items that left the snapshot are dropped; others are kept per item', () => {
  const state = run(opened(), requested(pr.id, diffKey(pr)), loaded(pr.id, diffKey(pr)),
    { type: 'sessionWorkItemSelected', itemId: dirty.id }, requested(dirty.id, diffKey(dirty)));
  assert.deepStrictEqual(Object.keys(page(state).diffs).sort(), [dirty.id, pr.id].sort());
  const gone = run(state, { type: 'sessionWorkSnapshot', snapshot: snapshot([dirty]) });
  assert.deepStrictEqual(Object.keys(page(gone).diffs), [dirty.id]);
});

test('diff: unified by default, the mode toggles, and a new page starts unified again', () => {
  const state = opened();
  assert.strictEqual(page(state).diffMode, 'unified');
  const split = run(state, { type: 'sessionWorkDiffModeSet', mode: 'split' });
  assert.strictEqual(page(split).diffMode, 'split');
  assert.strictEqual(run(split, { type: 'sessionWorkDiffModeSet', mode: 'split' }), split);
  const reopened = run(split, { type: 'sessionWorkClosed', sessionId: 's1' }, { type: 'sessionWorkOpened', sessionId: 's1', name: 'x', at: 0 });
  assert.strictEqual(page(reopened).diffMode, 'unified');
});

test('diff: Show diff opens a collapsed file, once', () => {
  const state = run(opened(), requested(pr.id, diffKey(pr)), loaded(pr.id, diffKey(pr)));
  const expand: RendererEvent = { type: 'sessionWorkFileExpanded', itemId: pr.id, path: 'package-lock.json' };
  const open = run(state, expand);
  assert.deepStrictEqual(selectedDiff(page(open))!.expanded, ['package-lock.json']);
  assert.strictEqual(run(open, expand), open);
  assert.strictEqual(run(state, { type: 'sessionWorkFileExpanded', itemId: 'nope', path: 'x' }), state);
});

test('diff: n/p move between files, from the first, stopping at either end', () => {
  const state = run(opened(), requested(pr.id, diffKey(pr)), loaded(pr.id, diffKey(pr)));
  const diff = selectedDiff(page(state))!;
  assert.strictEqual(steppedFilePath(diff, 1), 'a.ts', 'nothing focused yet: the first file');
  assert.strictEqual(steppedFilePath(diff, -1), 'a.ts');

  const second = run(state, { type: 'sessionWorkFileFocused', itemId: pr.id, path: 'package-lock.json' });
  const at = selectedDiff(page(second))!;
  assert.strictEqual(at.focusedPath, 'package-lock.json');
  assert.strictEqual(steppedFilePath(at, 1), 'logo.png');
  assert.strictEqual(steppedFilePath(at, -1), 'a.ts');
  assert.strictEqual(steppedFilePath({ ...at, focusedPath: 'logo.png' }, 1), null);
  assert.strictEqual(steppedFilePath({ ...at, files: [] }, 1), null);

  assert.strictEqual(run(state, { type: 'sessionWorkFileFocused', itemId: pr.id, path: 'not-in-it' }), state);
});

test('diff: a refreshed diff without the focused file forgets the focus', () => {
  const key = diffKey(pr);
  const state = run(opened(), requested(pr.id, key), loaded(pr.id, key),
    { type: 'sessionWorkFileFocused', itemId: pr.id, path: 'logo.png' },
    requested(pr.id, 'k2'), loaded(pr.id, 'k2', [file('a.ts')]));
  assert.strictEqual(selectedDiff(page(state))!.focusedPath, null);
});

test('diff: what the bar and the file cards say', () => {
  assert.deepStrictEqual(diffSummary(FILES), { label: '3 files changed', stats: { additions: 901, deletions: 2 } });
  assert.deepStrictEqual(diffSummary([file('a')]).label, '1 file changed');

  assert.deepStrictEqual(fileStatusPill(file('a', { status: 'added' }), false), { label: 'New', tone: 'green' });
  assert.deepStrictEqual(fileStatusPill(file('a', { status: 'added' }), true), { label: 'Untracked', tone: 'amber' });
  assert.deepStrictEqual(fileStatusPill(file('a', { status: 'deleted' }), false), { label: 'Deleted', tone: 'red' });
  assert.deepStrictEqual(fileStatusPill(file('a', { status: 'renamed', oldPath: 'b' }), false), { label: 'Renamed', tone: 'lavender' });
  assert.strictEqual(fileStatusPill(file('a'), false), null);

  assert.strictEqual(collapsedText(FILES[1]), 'Lock file');
  assert.strictEqual(collapsedText(file('dist/x.js', { collapsedReason: 'generated' })), 'Generated file');
  assert.strictEqual(collapsedText(file('big.ts', { collapsedReason: 'large', additions: 4000, deletions: 1000 })), 'Large diff · 5,000 lines changed');
  assert.strictEqual(collapsedText(file('a.ts')), null);
});
