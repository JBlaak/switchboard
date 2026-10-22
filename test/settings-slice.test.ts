import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(): RendererEvent {
  return {
    type: 'settingsOpened',
    current: { worktreeName: 'wt' },
    shellProfiles: [],
    appVersion: '2.2.0',
    quickAskRegistered: true, quickAskMissing: [],
  };
}

function projectLoaded(projectPath: string, current: Record<string, unknown> = { chrome: true }): RendererEvent {
  return { type: 'projectSettingsLoaded', projectPath, current, globalSettings: { worktree: true } };
}

test('settings: opening holds what is stored', () => {
  /* When */
  const state = run(initialRendererState(), opened());

  /* Then */
  assert.deepStrictEqual(state.settings.panel, {
    current: { worktreeName: 'wt' },
    shellProfiles: [],
    appVersion: '2.2.0',
    quickAskRegistered: true, quickAskMissing: [],
    openId: 1,
    saved: false,
  });
});

test('project settings: the read holds both blobs, not yet saved', () => {
  /* When */
  const state = run(initialRendererState(), projectLoaded('/p'));

  /* Then */
  assert.deepStrictEqual(state.settings.project, {
    projectPath: '/p', current: { chrome: true }, globalSettings: { worktree: true }, saved: false,
  });
});

test('project settings: a stored change replaces the project blob and says saved', () => {
  /* Given */
  const loaded = run(initialRendererState(), projectLoaded('/p'));

  /* When */
  const state = run(loaded, { type: 'projectSettingsSaved', projectPath: '/p', current: { chrome: false } });

  /* Then */
  assert.deepStrictEqual(state.settings.project, {
    projectPath: '/p', current: { chrome: false }, globalSettings: { worktree: true }, saved: true,
  });
});

test('project settings: a write for another project changes nothing', () => {
  /* Given */
  const loaded = run(initialRendererState(), projectLoaded('/p'));

  /* When */
  const state = run(loaded, { type: 'projectSettingsSaved', projectPath: '/q', current: {} });

  /* Then */
  assert.strictEqual(state.settings, loaded.settings);
});

test('project settings: opening the view again starts empty, with no "Saved" left over', () => {
  /* Given */
  const saved = run(initialRendererState(), projectLoaded('/p'),
    { type: 'projectSettingsSaved', projectPath: '/p', current: {} });

  /* When */
  const state = run(saved, { type: 'projectOpened', projectPath: '/p', view: { kind: 'settings' } });

  /* Then */
  assert.strictEqual(state.settings.project, null);
});

test('project settings: going to the overview keeps what was read', () => {
  /* Given */
  const loaded = run(initialRendererState(), projectLoaded('/p'));

  /* When */
  const state = run(loaded, { type: 'projectOpened', projectPath: '/p', view: { kind: 'overview' } });

  /* Then */
  assert.strictEqual(state.settings, loaded.settings);
});

test('settings: each open gets a new id, so a reopened form starts afresh', () => {
  /* Given */
  const saved = run(initialRendererState(), opened(), { type: 'settingsSaved' });

  /* When */
  const state = run(saved, opened());

  /* Then */
  assert.strictEqual(state.settings.panel?.openId, 2);
  assert.strictEqual(state.settings.panel?.saved, false);
});

test('settings: saving marks the open panel', () => {
  /* Given */
  const open = run(initialRendererState(), opened());

  /* When */
  const saved = run(open, { type: 'settingsSaved' });

  /* Then */
  assert.strictEqual(saved.settings.panel?.saved, true);
});

test('settings: closing drops the panel and keeps the open count', () => {
  /* Given */
  const saved = run(initialRendererState(), opened(), { type: 'settingsSaved' });

  /* When */
  const closed = run(saved, { type: 'settingsClosed' });

  /* Then */
  assert.strictEqual(closed.settings.panel, null);
  assert.strictEqual(closed.settings.opens, 1);
});

test('settings: saving a closed panel changes nothing', () => {
  /* Given */
  const initial = initialRendererState();

  /* When */
  const next = run(initial, { type: 'settingsSaved' });

  /* Then */
  assert.strictEqual(next, initial);
});

test('settings: closing a closed panel changes nothing', () => {
  /* Given */
  const initial = initialRendererState();

  /* When */
  const next = run(initial, { type: 'settingsClosed' });

  /* Then */
  assert.strictEqual(next, initial);
});

test('settings: saving an already saved panel changes nothing', () => {
  /* Given */
  const saved = run(initialRendererState(), opened(), { type: 'settingsSaved' });

  /* When */
  const next = run(saved, { type: 'settingsSaved' });

  /* Then */
  assert.strictEqual(next, saved);
});
