import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(scope: 'global' | 'project', projectPath: string | null = null): RendererEvent {
  return {
    type: 'settingsOpened',
    scope,
    projectPath,
    current: { worktreeName: 'wt' },
    globalSettings: {},
    shellProfiles: [],
    appVersion: scope === 'global' ? '2.2.0' : null,
    quickAskRegistered: true, quickAskMissing: [],
  };
}

test('settings: opening holds the scope and what is stored for it', () => {
  /* When */
  const state = run(initialRendererState(), opened('project', '/p'));

  /* Then */
  assert.deepStrictEqual(state.settings.panel, {
    scope: 'project',
    projectPath: '/p',
    current: { worktreeName: 'wt' },
    globalSettings: {},
    shellProfiles: [],
    appVersion: null,
    quickAskRegistered: true, quickAskMissing: [],
    openId: 1,
    saved: false,
  });
});

test('settings: each open gets a new id, so a reopened form starts afresh', () => {
  /* Given */
  const saved = run(initialRendererState(), opened('global'), { type: 'settingsSaved' });

  /* When */
  const state = run(saved, opened('global'));

  /* Then */
  assert.strictEqual(state.settings.panel?.openId, 2);
  assert.strictEqual(state.settings.panel?.saved, false);
});

test('settings: saving marks the open panel', () => {
  /* Given */
  const open = run(initialRendererState(), opened('global'));

  /* When */
  const saved = run(open, { type: 'settingsSaved' });

  /* Then */
  assert.strictEqual(saved.settings.panel?.saved, true);
});

test('settings: closing drops the panel and keeps the open count', () => {
  /* Given */
  const saved = run(initialRendererState(), opened('global'), { type: 'settingsSaved' });

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
  const saved = run(initialRendererState(), opened('global'), { type: 'settingsSaved' });

  /* When */
  const next = run(saved, { type: 'settingsSaved' });

  /* Then */
  assert.strictEqual(next, saved);
});
