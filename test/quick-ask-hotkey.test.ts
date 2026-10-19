import { test } from 'node:test';
import assert from 'node:assert';
import { QUICK_ASK_ACCELERATOR, QuickAskHotkey } from '../src/application/services/quick-ask-hotkey';
import { resolveQuickAskEnabled } from '../src/domain/settings/settings';
import { silentLog } from './support/fakes';
import type { GlobalHotkey, QuickAskPanel } from '../src/application/ports/quick-ask-panel';

/** A hotkey the OS hands out, or refuses while another app holds it. */
function fakeHotkey() {
  const held = new Map<string, () => void>();
  const calls: string[] = [];
  const hotkey: GlobalHotkey & { taken: boolean; held: Map<string, () => void>; calls: string[]; press(): void } = {
    taken: false,
    held,
    calls,
    register(accelerator, onPress) {
      calls.push('register ' + accelerator);
      if (hotkey.taken || held.has(accelerator)) return false;
      held.set(accelerator, onPress);
      return true;
    },
    unregister(accelerator) {
      calls.push('unregister ' + accelerator);
      held.delete(accelerator);
    },
    press() {
      held.get(QUICK_ASK_ACCELERATOR)?.();
    },
  };
  return hotkey;
}

function setup(stored: Record<string, unknown>) {
  const hotkey = fakeHotkey();
  let toggles = 0;
  const panel: QuickAskPanel = { show() {}, hide() {}, toggle() { toggles++; }, visible: false };
  const settings = { stored, quickAskEnabled: () => resolveQuickAskEnabled(settings.stored) };
  const service = new QuickAskHotkey({ hotkey, panel, settings, log: silentLog });
  return { hotkey, service, settings, toggles: () => toggles };
}

test('quick ask hotkey: with the setting on, ⌥Space is registered and each press toggles the panel once', () => {
  /* Given */
  const { hotkey, service, toggles } = setup({ quickAsk: true });
  service.apply();

  /* When */
  hotkey.press();
  hotkey.press();

  /* Then */
  assert.deepStrictEqual(hotkey.calls, ['register Alt+Space']);
  assert.strictEqual(service.registered, true);
  assert.strictEqual(toggles(), 2);
});

test('quick ask hotkey: an unset setting counts as on', () => {
  /* Given */
  const { hotkey, service } = setup({});

  /* When */
  service.apply();

  /* Then */
  assert.deepStrictEqual([...hotkey.held.keys()], ['Alt+Space']);
  assert.strictEqual(service.registered, true);
});

test('quick ask hotkey: with the setting off, nothing is registered', () => {
  /* Given */
  const { hotkey, service } = setup({ quickAsk: false });

  /* When */
  service.apply();

  /* Then */
  assert.deepStrictEqual(hotkey.calls, []);
  assert.strictEqual(service.registered, false);
});

test('quick ask hotkey: switching it off lets go of the key at once', () => {
  /* Given */
  const { hotkey, service, settings, toggles } = setup({ quickAsk: true });
  service.apply();
  settings.stored = { quickAsk: false };

  /* When */
  service.apply();
  hotkey.press();

  /* Then */
  assert.deepStrictEqual(hotkey.calls, ['register Alt+Space', 'unregister Alt+Space']);
  assert.strictEqual(service.registered, false);
  assert.strictEqual(toggles(), 0);
});

test('quick ask hotkey: switching it on again registers again', () => {
  /* Given */
  const { hotkey, service, settings, toggles } = setup({ quickAsk: true });
  service.apply();
  settings.stored = { quickAsk: false };
  service.apply();
  settings.stored = { quickAsk: true };

  /* When */
  service.apply();
  hotkey.press();

  /* Then */
  assert.strictEqual(service.registered, true);
  assert.strictEqual(toggles(), 1);
});

test('quick ask hotkey: another save with it on keeps the key without registering twice', () => {
  /* Given */
  const { hotkey, service } = setup({ quickAsk: true });
  service.apply();

  /* When */
  service.apply();

  /* Then */
  assert.deepStrictEqual(hotkey.calls, ['register Alt+Space']);
  assert.strictEqual(service.registered, true);
});

test('quick ask hotkey: a key another app holds is remembered as not registered', () => {
  /* Given */
  const { hotkey, service } = setup({ quickAsk: true });
  hotkey.taken = true;

  /* When */
  service.apply();

  /* Then */
  assert.strictEqual(service.registered, false);
});

test('quick ask hotkey: after a refusal, switching off and on tries again', () => {
  /* Given */
  const { hotkey, service, settings } = setup({ quickAsk: true });
  hotkey.taken = true;
  service.apply();
  hotkey.taken = false;
  settings.stored = { quickAsk: false };
  service.apply();
  settings.stored = { quickAsk: true };

  /* When */
  service.apply();

  /* Then */
  // Nothing was held after the refusal, so switching off had nothing to let go of.
  assert.deepStrictEqual(hotkey.calls, ['register Alt+Space', 'register Alt+Space']);
  assert.strictEqual(service.registered, true);
});
