/**
 * Holding ⌥Space for Quick Ask while the setting says so (H2, H3).
 *
 * `apply` is called once the window is open and again after every save of the
 * global settings: it registers the shortcut when the setting is on and it is
 * not held yet, and lets go of it when the setting is off. A registration the
 * OS refused is only remembered, never retried on a timer, so the settings
 * switch can say the key is taken and switching it off and on tries again.
 */
import type { Logger } from '../ports/logger';
import type { GlobalHotkey, QuickAskPanel } from '../ports/quick-ask-panel';

/** ⌥Space, fixed (H2). */
export const QUICK_ASK_ACCELERATOR = 'Alt+Space';

/** The one setting this reads, rather than the whole SettingsService. */
export interface QuickAskSettings {
  quickAskEnabled(): boolean;
}

export interface QuickAskHotkeyDeps {
  hotkey: GlobalHotkey;
  panel: QuickAskPanel;
  settings: QuickAskSettings;
  log: Logger;
}

export class QuickAskHotkey {
  #registered = false;

  constructor(private readonly deps: QuickAskHotkeyDeps) {}

  /** Whether the shortcut is held right now. */
  get registered(): boolean {
    return this.#registered;
  }

  apply(): void {
    const { hotkey, panel, settings, log } = this.deps;
    if (!settings.quickAskEnabled()) {
      if (this.#registered) hotkey.unregister(QUICK_ASK_ACCELERATOR);
      this.#registered = false;
      return;
    }
    if (this.#registered) return;
    this.#registered = hotkey.register(QUICK_ASK_ACCELERATOR, () => panel.toggle());
    if (!this.#registered) log.warn(`[quick-ask] ${QUICK_ASK_ACCELERATOR} is in use by another app`);
  }
}
