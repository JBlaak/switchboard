import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { initialDialogState, dialogReducer } from '../src/renderer/state/dialog-slice';
import { labelRuns, rankProjects } from '../src/renderer/ui/dialogs/rank-projects';
import {
  DANGEROUS_SKIP, applyPermissionSelection, pickPermission,
} from '../src/renderer/ui/dialogs/permission-selection';
import type { Project } from '../src/domain/project/project';
import type { SessionOptions } from '../src/domain/launch/session-options';
import type { SessionRow } from '../src/domain/session/session';

// ── The dialog slice ──

test('opening a dialog counts the opening and replaces whatever was open', () => {
  let state = dialogReducer(initialDialogState, { type: 'dialogOpened', request: { kind: 'projectPicker' } });
  assert.deepStrictEqual(state, { open: { kind: 'projectPicker' }, seq: 1 });
  state = dialogReducer(state, { type: 'dialogOpened', request: { kind: 'addProject' } });
  assert.deepStrictEqual(state, { open: { kind: 'addProject' }, seq: 2 });
});

test('a close only closes the opening it names', () => {
  const first = dialogReducer(initialDialogState, { type: 'dialogOpened', request: { kind: 'projectPicker' } });
  const second = dialogReducer(first, { type: 'dialogOpened', request: { kind: 'addProject' } });
  assert.strictEqual(dialogReducer(second, { type: 'dialogClosed', seq: 1 }), second);
  assert.deepStrictEqual(dialogReducer(second, { type: 'dialogClosed', seq: 2 }), { open: null, seq: 2 });
});

test('closing when nothing is open keeps the state', () => {
  assert.strictEqual(dialogReducer(initialDialogState, { type: 'dialogClosed', seq: 0 }), initialDialogState);
});

test('the root reducer carries the dialog slice', () => {
  const state = rootReducer(initialRendererState(), { type: 'dialogOpened', request: { kind: 'addProject' } });
  assert.deepStrictEqual(state.dialog.open, { kind: 'addProject' });
  assert.strictEqual(rootReducer(state, { type: 'usageFailed' }).dialog, state.dialog);
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
  const ranked = rankProjects([
    project(`${HOME}/Development/old`, '2026-01-01T00:00:00Z'),
    project(`${HOME}/Development/new`, '2026-03-01T00:00:00Z', '2025-01-01T00:00:00Z'),
    project(`${HOME}/Development/empty`),
  ], '');
  assert.deepStrictEqual(ranked.map(c => c.project.projectPath.split('/').pop()), ['new', 'old', 'empty']);
});

test('a label match outranks a match on the full path alone', () => {
  const ranked = rankProjects([
    project('/srv/switchboard-data/website', '2026-03-01T00:00:00Z'),
    project('/srv/code/sb', '2026-01-01T00:00:00Z'),
  ], 'sb');
  const sb = ranked.find(c => c.project.projectPath === '/srv/code/sb');
  assert.ok(sb?.onLabel);
  assert.strictEqual(ranked[0], sb);
});

test('a path-only match has nothing to highlight in the label', () => {
  const [only] = rankProjects([project('/srv/zz-hidden/code/visible')], 'zz');
  assert.ok(only);
  assert.strictEqual(only.onLabel, false);
  assert.deepStrictEqual(only.positions, []);
});

test('nothing matches, nothing is listed', () => {
  assert.deepStrictEqual(rankProjects([project('/srv/code/sb')], 'qqq'), []);
});

// ── Highlight runs ──

test('contiguous matches become one run', () => {
  assert.deepStrictEqual(labelRuns('acme-api', [0, 1, 2, 3]), [
    { text: 'acme', matched: true },
    { text: '-api', matched: false },
  ]);
});

test('scattered matches alternate with the text between them', () => {
  assert.deepStrictEqual(labelRuns('web', [0, 2]), [
    { text: 'w', matched: true },
    { text: 'e', matched: false },
    { text: 'b', matched: true },
  ]);
});

test('no positions is one plain run', () => {
  assert.deepStrictEqual(labelRuns('notes', []), [{ text: 'notes', matched: false }]);
});

// ── The permission grid ──

test('picking a mode replaces the one before it and clears Dangerous Skip', () => {
  assert.deepStrictEqual(pickPermission({ mode: 'plan', dangerousSkip: false }, 'auto'), { mode: 'auto', dangerousSkip: false });
  assert.deepStrictEqual(pickPermission({ mode: null, dangerousSkip: true }, 'plan'), { mode: 'plan', dangerousSkip: false });
  assert.deepStrictEqual(pickPermission({ mode: 'plan', dangerousSkip: false }, null), { mode: null, dangerousSkip: false });
});

test('Dangerous Skip toggles, and turning it on clears the mode', () => {
  const on = pickPermission({ mode: 'plan', dangerousSkip: false }, DANGEROUS_SKIP);
  assert.deepStrictEqual(on, { mode: null, dangerousSkip: true });
  assert.deepStrictEqual(pickPermission(on, DANGEROUS_SKIP), { mode: null, dangerousSkip: false });
});

test('a selection folds into the launch options', () => {
  const dangerous: SessionOptions = {};
  applyPermissionSelection(dangerous, { mode: 'plan', dangerousSkip: true });
  assert.deepStrictEqual(dangerous, { dangerouslySkipPermissions: true });

  const mode: SessionOptions = {};
  applyPermissionSelection(mode, { mode: 'plan', dangerousSkip: false });
  assert.deepStrictEqual(mode, { permissionMode: 'plan' });

  const none: SessionOptions = {};
  applyPermissionSelection(none, { mode: null, dangerousSkip: false });
  assert.deepStrictEqual(none, {});
});
