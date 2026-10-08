/**
 * Settings and shell profiles.
 */
import { INVOKE } from '../../ipc/channels';
import { normaliseAppearance } from '../../domain/settings/appearance';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerSettingsHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.getSetting, (key: string) => app.settings.get(key));
  ipc.handle(INVOKE.setSetting, (key: string, value: unknown) => {
    app.settings.set(key, value);
    return { ok: true };
  });

  ipc.handle(INVOKE.getEffectiveSettings, (projectPath: string | null) =>
    app.settings.effective(projectPath));

  /**
   * The shells this machine has.
   *
   * Discovered once per launch. Re-discovering per request would shell out to
   * `wsl.exe --list` every time the settings panel opened.
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
