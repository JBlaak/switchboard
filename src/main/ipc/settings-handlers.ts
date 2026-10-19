/**
 * Settings and shell profiles.
 */
import { INVOKE } from '../../ipc/channels';
import { normaliseAppearance } from '../../domain/settings/appearance';
import { GLOBAL_SETTINGS_KEY } from '../../domain/settings/settings';
import { CAPTURE_SERVERS, CAPTURE_TARGETS } from '../../domain/ask/capture';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerSettingsHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.getSetting, (key: string) => app.settings.get(key));
  ipc.handle(INVOKE.setSetting, (key: string, value: unknown) => {
    app.settings.set(key, value);
    // Saving registers or lets go of ⌥Space at once, no restart (H2).
    if (key === GLOBAL_SETTINGS_KEY) app.quickAskHotkey.apply();
    return { ok: true };
  });

  /**
   * Whether ⌥Space is held, for the settings switch's "in use" line (H3), and
   * which capture servers aren't set up, for its "isn't set up" line (C6).
   */
  ipc.handle(INVOKE.quickAskHotkeyStatus, () => ({
    registered: app.quickAskHotkey.registered,
    missing: CAPTURE_TARGETS.filter(target => !app.mcpServers.has(CAPTURE_SERVERS[target])),
  }));

  ipc.handle(INVOKE.getEffectiveSettings, (projectPath: string | null) =>
    app.settings.effective(projectPath));

  /**
   * The shells this machine has.
   *
   * Discovered once per launch rather than re-reading /etc/shells every time
   * the settings panel opens.
   */
  ipc.handle(INVOKE.getShellProfiles, () => app.shells.list());

  /**
   * Store the colour scheme, then apply it.
   *
   * Normalised first: the argument comes from the renderer, and an unknown
   * string handed to `themeSource` throws rather than being ignored.
   */
  ipc.handle(INVOKE.setAppearance, (mode: unknown) => {
    const appearance = normaliseAppearance(mode);
    app.settings.updateGlobal((settings) => {
      settings.appearance = appearance;
    });
    app.appearance.apply(appearance);
    return { ok: true, appearance };
  });
}
