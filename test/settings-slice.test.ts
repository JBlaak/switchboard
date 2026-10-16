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
  };
}

test('settings: opening holds the scope and what is stored for it', () => {
  const state = run(initialRendererState(), opened('project', '/p'));
  assert.deepStrictEqual(state.settings.panel, {
    scope: 'project',
    projectPath: '/p',
    current: { worktreeName: 'wt' },
    globalSettings: {},
    shellProfiles: [],
    appVersion: null,
    openId: 1,
    saved: false,
  });
});

test('settings: each open gets a new id, so a reopened form starts afresh', () => {
  const state = run(initialRendererState(), opened('global'), { type: 'settingsSaved' }, opened('global'));
  assert.strictEqual(state.settings.panel?.openId, 2);
  assert.strictEqual(state.settings.panel?.saved, false);
});

test('settings: saving marks the open panel, closing drops it', () => {
  const saved = run(initialRendererState(), opened('global'), { type: 'settingsSaved' });
  assert.strictEqual(saved.settings.panel?.saved, true);
  const closed = run(saved, { type: 'settingsClosed' });
  assert.strictEqual(closed.settings.panel, null);
  assert.strictEqual(closed.settings.opens, 1);
});

test('settings: saving or closing a closed panel changes nothing', () => {
  const initial = initialRendererState();
  assert.strictEqual(run(initial, { type: 'settingsSaved' }), initial);
  assert.strictEqual(run(initial, { type: 'settingsClosed' }), initial);
  const saved = run(initial, opened('global'), { type: 'settingsSaved' });
  assert.strictEqual(run(saved, { type: 'settingsSaved' }), saved);
});
