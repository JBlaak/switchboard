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

/** The page with the pr's diff asked for. */
const asking = (key = diffKey(pr)): RendererState => run(opened(), requested(pr.id, key));
/** The page with the pr's diff shown. */
const shown = (): RendererState => run(opened(), requested(pr.id, diffKey(pr)), loaded(pr.id, diffKey(pr)));

test('diff: the selected item\'s diff is wanted until it is asked for', () => {
  /* Given */
  const state = opened();

  /* When */
  const wanted = diffToLoad(page(state));

  /* Then */
  assert.deepStrictEqual(wanted, { itemId: pr.id, key: diffKey(pr) });
});

test('diff: a diff asked for is loading and no longer wanted', () => {
  /* Given */
  const state = opened();

  /* When */
  const next = run(state, requested(pr.id, diffKey(pr)));

  /* Then */
  assert.strictEqual(diffToLoad(page(next)), null, 'on its way');
  assert.deepStrictEqual(selectedDiff(page(next)), {
    key: diffKey(pr), phase: 'loading', files: [], source: null, error: null, expanded: [], focusedPath: null,
  });
});

test('diff: asking twice changes nothing', () => {
  /* Given */
  const state = asking();

  /* When */
  const next = run(state, requested(pr.id, diffKey(pr)));

  /* Then */
  assert.strictEqual(next, state, 'asking twice changes nothing');
});

test('diff: an issue has no diff', () => {
  /* When */
  const key = diffKey(issue);

  /* Then */
  assert.strictEqual(key, '');
});

test('diff: an issue selected wants no diff', () => {
  /* Given */
  const state = opened([issue]);

  /* When */
  const wanted = diffToLoad(page(state));

  /* Then */
  assert.strictEqual(wanted, null);
});

test('diff: the answer fills it, with where it came from', () => {
  /* Given */
  const state = asking();

  /* When */
  const next = run(state, loaded(pr.id, diffKey(pr), FILES, 'github'));

  /* Then */
  const diff = selectedDiff(page(next))!;
  assert.strictEqual(diff.phase, 'loaded');
  assert.strictEqual(diff.files, FILES);
  assert.strictEqual(diff.source, 'github');
  assert.strictEqual(diffToLoad(page(next)), null);
});

test('diff: an answer for an item that changed since is dropped', () => {
  /* Given */
  const state = asking('old-key');

  /* When */
  const next = run(state, loaded(pr.id, 'older-key'));

  /* Then */
  assert.strictEqual(next, state);
});

test('diff: an answer for an item that was never asked for is dropped', () => {
  /* Given */
  const state = asking('old-key');

  /* When */
  const next = run(state, loaded(dirty.id, diffKey(dirty)));

  /* Then */
  assert.strictEqual(next, state);
});

test('diff: an error with no files is a failure', () => {
  /* Given */
  const key = diffKey(pr);
  const state = asking(key);

  /* When */
  const failed = run(state, {
    type: 'sessionWorkDiffLoaded', sessionId: 's1', itemId: pr.id, key,
    diff: { files: [], source: null, error: 'GitHub did not send the diff' },
  });

  /* Then */
  assert.strictEqual(selectedDiff(page(failed))!.phase, 'failed');
  assert.strictEqual(selectedDiff(page(failed))!.error, 'GitHub did not send the diff');
});

test('diff: a failed request is a failure, not asked again until the item changes', () => {
  /* Given */
  const key = diffKey(pr);
  const state = asking(key);

  /* When */
  const thrown = run(state, { type: 'sessionWorkDiffFailed', sessionId: 's1', itemId: pr.id, key, message: 'IPC gone' });

  /* Then */
  assert.deepStrictEqual([selectedDiff(page(thrown))!.phase, selectedDiff(page(thrown))!.error], ['failed', 'IPC gone']);
  assert.strictEqual(diffToLoad(page(thrown)), null, 'not asked again until the item changes');
});

const pushed: SessionWorkItem = { ...pr, pr: { ...pr.pr, headSha: 'bbb' } } as SessionWorkItem;
const shownExpanded = (): RendererState =>
  run(shown(), { type: 'sessionWorkFileExpanded', itemId: pr.id, path: 'package-lock.json' });

test('diff: a snapshot that changes the item asks again', () => {
  /* Given */
  const state = shownExpanded();

  /* When */
  const changed = run(state, { type: 'sessionWorkSnapshot', snapshot: snapshot([pushed, dirty]) });

  /* Then */
  assert.deepStrictEqual(diffToLoad(page(changed)), { itemId: pr.id, key: diffKey(pushed) });
  assert.notStrictEqual(diffKey(pushed), diffKey(pr));
});

test('diff: asking again keeps what is shown meanwhile', () => {
  /* Given */
  const changed = run(shownExpanded(), { type: 'sessionWorkSnapshot', snapshot: snapshot([pushed, dirty]) });

  /* When */
  const again = run(changed, requested(pr.id, diffKey(pushed)));

  /* Then */
  const diff = selectedDiff(page(again))!;
  assert.strictEqual(diff.phase, 'loading');
  assert.strictEqual(diff.files, FILES, 'the old files stay up while the new ones load');
  assert.deepStrictEqual(diff.expanded, ['package-lock.json']);
});

test('diff: an activity or an error on the item is not a new diff', () => {
  /* Given */
  const busy = { ...pr, activity: { id: 'a1', action: 'ship', phase: 'sent', origin: 'manual', queuedAt: 'x' }, error: 'e' } as SessionWorkItem;

  /* When */
  const key = diffKey(busy);

  /* Then */
  assert.strictEqual(key, diffKey(pr));
});

test('diff: a change in a dirty item\'s files is a new diff', () => {
  /* Given */
  const edited = { ...dirty, files: [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'untracked' }] } as SessionWorkItem;

  /* When */
  const key = diffKey(edited);

  /* Then */
  assert.notStrictEqual(key, diffKey(dirty));
});

const bothAsked = (): RendererState => run(shown(),
  { type: 'sessionWorkItemSelected', itemId: dirty.id }, requested(dirty.id, diffKey(dirty)));

test('diff: diffs are kept per item', () => {
  /* When */
  const state = bothAsked();

  /* Then */
  assert.deepStrictEqual(Object.keys(page(state).diffs).sort(), [dirty.id, pr.id].sort());
});

test('diff: diffs of items that left the snapshot are dropped', () => {
  /* Given */
  const state = bothAsked();

  /* When */
  const gone = run(state, { type: 'sessionWorkSnapshot', snapshot: snapshot([dirty]) });

  /* Then */
  assert.deepStrictEqual(Object.keys(page(gone).diffs), [dirty.id]);
});

const setSplit: RendererEvent = { type: 'sessionWorkDiffModeSet', mode: 'split' };

test('diff: unified by default', () => {
  /* When */
  const state = opened();

  /* Then */
  assert.strictEqual(page(state).diffMode, 'unified');
});

test('diff: the mode toggles', () => {
  /* Given */
  const state = opened();

  /* When */
  const split = run(state, setSplit);

  /* Then */
  assert.strictEqual(page(split).diffMode, 'split');
});

test('diff: setting the mode it is already in changes nothing', () => {
  /* Given */
  const split = run(opened(), setSplit);

  /* When */
  const next = run(split, setSplit);

  /* Then */
  assert.strictEqual(next, split);
});

test('diff: a new page starts unified again', () => {
  /* Given */
  const split = run(opened(), setSplit);

  /* When */
  const reopened = run(split, { type: 'sessionWorkClosed', sessionId: 's1' }, { type: 'sessionWorkOpened', sessionId: 's1', name: 'x', at: 0 });

  /* Then */
  assert.strictEqual(page(reopened).diffMode, 'unified');
});

const expand: RendererEvent = { type: 'sessionWorkFileExpanded', itemId: pr.id, path: 'package-lock.json' };

test('diff: Show diff opens a collapsed file', () => {
  /* Given */
  const state = shown();

  /* When */
  const open = run(state, expand);

  /* Then */
  assert.deepStrictEqual(selectedDiff(page(open))!.expanded, ['package-lock.json']);
});

test('diff: Show diff opens a collapsed file only once', () => {
  /* Given */
  const open = run(shown(), expand);

  /* When */
  const next = run(open, expand);

  /* Then */
  assert.strictEqual(next, open);
});

test('diff: Show diff on an unknown item changes nothing', () => {
  /* Given */
  const state = shown();

  /* When */
  const next = run(state, { type: 'sessionWorkFileExpanded', itemId: 'nope', path: 'x' });

  /* Then */
  assert.strictEqual(next, state);
});

test('diff: n/p start from the first file when nothing is focused yet', () => {
  /* Given */
  const diff = selectedDiff(page(shown()))!;

  /* When */
  const next = steppedFilePath(diff, 1);
  const previous = steppedFilePath(diff, -1);

  /* Then */
  assert.strictEqual(next, 'a.ts', 'nothing focused yet: the first file');
  assert.strictEqual(previous, 'a.ts');
});

test('diff: focusing a file records it', () => {
  /* Given */
  const state = shown();

  /* When */
  const second = run(state, { type: 'sessionWorkFileFocused', itemId: pr.id, path: 'package-lock.json' });

  /* Then */
  assert.strictEqual(selectedDiff(page(second))!.focusedPath, 'package-lock.json');
});

const focusedOnSecond = () =>
  selectedDiff(page(run(shown(), { type: 'sessionWorkFileFocused', itemId: pr.id, path: 'package-lock.json' })))!;

test('diff: n/p move between files from the focused one', () => {
  /* Given */
  const at = focusedOnSecond();

  /* When */
  const next = steppedFilePath(at, 1);
  const previous = steppedFilePath(at, -1);

  /* Then */
  assert.strictEqual(next, 'logo.png');
  assert.strictEqual(previous, 'a.ts');
});

test('diff: n/p stop at either end', () => {
  /* Given */
  const at = focusedOnSecond();

  /* When */
  const pastLast = steppedFilePath({ ...at, focusedPath: 'logo.png' }, 1);
  const noFiles = steppedFilePath({ ...at, files: [] }, 1);

  /* Then */
  assert.strictEqual(pastLast, null);
  assert.strictEqual(noFiles, null);
});

test('diff: focusing a file that is not in the diff changes nothing', () => {
  /* Given */
  const state = shown();

  /* When */
  const next = run(state, { type: 'sessionWorkFileFocused', itemId: pr.id, path: 'not-in-it' });

  /* Then */
  assert.strictEqual(next, state);
});

test('diff: a refreshed diff without the focused file forgets the focus', () => {
  /* Given */
  const focused = run(shown(), { type: 'sessionWorkFileFocused', itemId: pr.id, path: 'logo.png' });

  /* When */
  const state = run(focused, requested(pr.id, 'k2'), loaded(pr.id, 'k2', [file('a.ts')]));

  /* Then */
  assert.strictEqual(selectedDiff(page(state))!.focusedPath, null);
});

test('diff: the bar counts the files and lines changed', () => {
  /* When */
  const summary = diffSummary(FILES);
  const one = diffSummary([file('a')]);

  /* Then */
  assert.deepStrictEqual(summary, { label: '3 files changed', stats: { additions: 901, deletions: 2 } });
  assert.deepStrictEqual(one.label, '1 file changed');
});

test('diff: a file card\'s pill says how the file changed', () => {
  /* Given */
  const cases: Array<[FileDiff, boolean, ReturnType<typeof fileStatusPill>]> = [
    [file('a', { status: 'added' }), false, { label: 'New', tone: 'green' }],
    [file('a', { status: 'added' }), true, { label: 'Untracked', tone: 'amber' }],
    [file('a', { status: 'deleted' }), false, { label: 'Deleted', tone: 'red' }],
    [file('a', { status: 'renamed', oldPath: 'b' }), false, { label: 'Renamed', tone: 'lavender' }],
    [file('a'), false, null],
  ];

  for (const [changed, untracked, expected] of cases) {
    /* When */
    const pill = fileStatusPill(changed, untracked);

    /* Then */
    assert.deepStrictEqual(pill, expected);
  }
});

test('diff: a collapsed file card says why it is collapsed', () => {
  /* Given */
  const cases: Array<[FileDiff, string | null]> = [
    [FILES[1], 'Lock file'],
    [file('dist/x.js', { collapsedReason: 'generated' }), 'Generated file'],
    [file('big.ts', { collapsedReason: 'large', additions: 4000, deletions: 1000 }), 'Large diff · 5,000 lines changed'],
    [file('a.ts'), null],
  ];

  for (const [changed, expected] of cases) {
    /* When */
    const text = collapsedText(changed);

    /* Then */
    assert.strictEqual(text, expected);
  }
});
