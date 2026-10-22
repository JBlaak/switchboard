import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { initialDialogState, dialogReducer } from '../src/renderer/state/dialog-slice';
import { labelRuns, rankProjects } from '../src/renderer/ui/dialogs/rank-projects';
import {
  DANGEROUS_SKIP, applyPermissionSelection, pickPermission,
} from '../src/renderer/ui/dialogs/permission-selection';
import type { DialogRequest } from '../src/renderer/state/dialog-slice';
import type { Project } from '../src/domain/project/project';
import type { SessionOptions } from '../src/domain/launch/session-options';
import type { SessionRow } from '../src/domain/session/session';

// ── The dialog slice ──

const PICKER: DialogRequest = { kind: 'projectPicker' };
/** The same modal opened again, carrying a prompt from the empty screen. */
const PICKER_WITH_PROMPT: DialogRequest = { kind: 'projectPicker', initialPrompt: 'fix the login loop' };
const opened = (request: DialogRequest) => ({ type: 'dialogOpened' as const, request });
const pickerTwice = () => dialogReducer(dialogReducer(initialDialogState, opened(PICKER)), opened(PICKER_WITH_PROMPT));

test('opening a dialog counts the opening', () => {
  /* When */
  const state = dialogReducer(initialDialogState, opened(PICKER));

  /* Then */
  assert.deepStrictEqual(state, { open: { kind: 'projectPicker' }, seq: 1 });
});

test('opening a dialog replaces whatever was open', () => {
  /* Given */
  const state = dialogReducer(initialDialogState, opened(PICKER));

  /* When */
  const next = dialogReducer(state, opened(PICKER_WITH_PROMPT));

  /* Then */
  assert.deepStrictEqual(next, { open: PICKER_WITH_PROMPT, seq: 2 });
});

test('a close naming an earlier opening keeps the state', () => {
  /* Given */
  const second = pickerTwice();

  /* When */
  const next = dialogReducer(second, { type: 'dialogClosed', seq: 1 });

  /* Then */
  assert.strictEqual(next, second);
});

test('a close naming the current opening closes it', () => {
  /* Given */
  const second = pickerTwice();

  /* When */
  const next = dialogReducer(second, { type: 'dialogClosed', seq: 2 });

  /* Then */
  assert.deepStrictEqual(next, { open: null, seq: 2 });
});

test('closing when nothing is open keeps the state', () => {
  /* When */
  const next = dialogReducer(initialDialogState, { type: 'dialogClosed', seq: 0 });

  /* Then */
  assert.strictEqual(next, initialDialogState);
});

test('the root reducer carries the dialog slice', () => {
  /* When */
  const state = rootReducer(initialRendererState(), opened(PICKER_WITH_PROMPT));

  /* Then */
  assert.deepStrictEqual(state.dialog.open, PICKER_WITH_PROMPT);
});

test('the root reducer leaves the dialog slice alone for other events', () => {
  /* Given */
  const state = rootReducer(initialRendererState(), opened(PICKER_WITH_PROMPT));

  /* When */
  const next = rootReducer(state, { type: 'usageFailed' });

  /* Then */
  assert.strictEqual(next.dialog, state.dialog);
});

// ── Ranking the picker ──

function project(projectPath: string, ...modified: string[]): Project {
  return {
    projectPath,
    folder: projectPath.replace(/\//g, '-'),
    sessions: modified.map((at, i) => ({ sessionId: `${projectPath}-${i}`, modified: at }) as SessionRow),
  };
}

const HOME = '/Users/someone';

test('with no query every project is listed, most recently active first', () => {
  /* Given */
  const projects = [
    project(`${HOME}/Development/old`, '2026-01-01T00:00:00Z'),
    project(`${HOME}/Development/new`, '2026-03-01T00:00:00Z', '2025-01-01T00:00:00Z'),
    project(`${HOME}/Development/empty`),
  ];

  /* When */
  const ranked = rankProjects(projects, '');

  /* Then */
  assert.deepStrictEqual(ranked.map(c => c.project.projectPath.split('/').pop()), ['new', 'old', 'empty']);
});

test('a label match outranks a match on the full path alone', () => {
  /* Given */
  const projects = [
    project('/srv/switchboard-data/website', '2026-03-01T00:00:00Z'),
    project('/srv/code/sb', '2026-01-01T00:00:00Z'),
  ];

  /* When */
  const ranked = rankProjects(projects, 'sb');

  /* Then */
  const sb = ranked.find(c => c.project.projectPath === '/srv/code/sb');
  assert.ok(sb?.onLabel);
  assert.strictEqual(ranked[0], sb);
});

test('a path-only match has nothing to highlight in the label', () => {
  /* Given */
  const projects = [project('/srv/zz-hidden/code/visible')];

  /* When */
  const [only] = rankProjects(projects, 'zz');

  /* Then */
  assert.ok(only);
  assert.strictEqual(only.onLabel, false);
  assert.deepStrictEqual(only.positions, []);
});

test('nothing matches, nothing is listed', () => {
  /* Given */
  const projects = [project('/srv/code/sb')];

  /* When */
  const ranked = rankProjects(projects, 'qqq');

  /* Then */
  assert.deepStrictEqual(ranked, []);
});

// ── Highlight runs ──

test('contiguous matches become one run', () => {
  /* When */
  const runs = labelRuns('acme-api', [0, 1, 2, 3]);

  /* Then */
  assert.deepStrictEqual(runs, [
    { text: 'acme', matched: true },
    { text: '-api', matched: false },
  ]);
});

test('scattered matches alternate with the text between them', () => {
  /* When */
  const runs = labelRuns('web', [0, 2]);

  /* Then */
  assert.deepStrictEqual(runs, [
    { text: 'w', matched: true },
    { text: 'e', matched: false },
    { text: 'b', matched: true },
  ]);
});

test('no positions is one plain run', () => {
  /* When */
  const runs = labelRuns('notes', []);

  /* Then */
  assert.deepStrictEqual(runs, [{ text: 'notes', matched: false }]);
});

// ── The permission grid ──

test('picking a mode replaces the one before it', () => {
  /* When */
  const picked = pickPermission({ mode: 'plan', dangerousSkip: false }, 'auto');

  /* Then */
  assert.deepStrictEqual(picked, { mode: 'auto', dangerousSkip: false });
});

test('picking a mode clears Dangerous Skip', () => {
  /* When */
  const picked = pickPermission({ mode: null, dangerousSkip: true }, 'plan');

  /* Then */
  assert.deepStrictEqual(picked, { mode: 'plan', dangerousSkip: false });
});

test('picking no mode clears the mode', () => {
  /* When */
  const picked = pickPermission({ mode: 'plan', dangerousSkip: false }, null);

  /* Then */
  assert.deepStrictEqual(picked, { mode: null, dangerousSkip: false });
});

test('turning Dangerous Skip on clears the mode', () => {
  /* When */
  const on = pickPermission({ mode: 'plan', dangerousSkip: false }, DANGEROUS_SKIP);

  /* Then */
  assert.deepStrictEqual(on, { mode: null, dangerousSkip: true });
});

test('Dangerous Skip toggles off again', () => {
  /* Given */
  const on = pickPermission({ mode: 'plan', dangerousSkip: false }, DANGEROUS_SKIP);

  /* When */
  const off = pickPermission(on, DANGEROUS_SKIP);

  /* Then */
  assert.deepStrictEqual(off, { mode: null, dangerousSkip: false });
});

test('a Dangerous Skip selection folds into the launch options, over any mode', () => {
  /* Given */
  const options: SessionOptions = {};

  /* When */
  applyPermissionSelection(options, { mode: 'plan', dangerousSkip: true });

  /* Then */
  assert.deepStrictEqual(options, { dangerouslySkipPermissions: true });
});

test('a mode selection folds into the launch options', () => {
  /* Given */
  const options: SessionOptions = {};

  /* When */
  applyPermissionSelection(options, { mode: 'plan', dangerousSkip: false });

  /* Then */
  assert.deepStrictEqual(options, { permissionMode: 'plan' });
});

test('an empty selection leaves the launch options empty', () => {
  /* Given */
  const options: SessionOptions = {};

  /* When */
  applyPermissionSelection(options, { mode: null, dangerousSkip: false });

  /* Then */
  assert.deepStrictEqual(options, {});
});
