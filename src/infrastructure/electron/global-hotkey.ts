/**
 * The system-wide shortcut, through Electron's `globalShortcut`.
 *
 * Under the e2e harness a stand-in takes its place: a test run must not take
 * ⌥Space from the developer's own Mac, and Playwright cannot press a global
 * shortcut anyway. The stand-in holds the callback, so a test hook can press
 * it, and can be told to refuse, as the OS does when another app has the key.
 */
import { globalShortcut } from 'electron';
import type { GlobalHotkey } from '../../application/ports/quick-ask-panel';

export class ElectronGlobalHotkey implements GlobalHotkey {
  register(accelerator: string, onPress: () => void): boolean {
    return globalShortcut.register(accelerator, onPress);
  }

  unregister(accelerator: string): void {
    globalShortcut.unregister(accelerator);
  }
}

export class E2eGlobalHotkey implements GlobalHotkey {
  readonly #held = new Map<string, () => void>();
  /** Set by a test: every registration fails, as if another app had the key. */
  refusing = false;

  register(accelerator: string, onPress: () => void): boolean {
    if (this.refusing || this.#held.has(accelerator)) return false;
    this.#held.set(accelerator, onPress);
    return true;
  }

  unregister(accelerator: string): void {
    this.#held.delete(accelerator);
  }

  /** Do what pressing the key would. False when nothing holds it. */
  press(accelerator: string): boolean {
    const onPress = this.#held.get(accelerator);
    onPress?.();
    return !!onPress;
  }
}
