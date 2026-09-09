/**
 * Settings, shell profiles and scheduled tasks.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerSettingsHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.getSetting, (key: string) => app.settings.get(key));
  ipc.handle(INVOKE.setSetting, (key: string, value: unknown) => {
    app.settings.set(key, value);
    return { ok: true };
  });
  ipc.handle(INVOKE.deleteSetting, (key: string) => {
    app.settings.delete(key);
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

  // ── Scheduled tasks ──
  ipc.handle(INVOKE.getScheduleCreatorCommand, () => app.schedules.readCreatorCommand());
  ipc.handle(INVOKE.createScheduleSession, (projectPath: string) =>
    app.schedules.createCreatorSession(projectPath));
  ipc.handle(INVOKE.runScheduleNow, (filePath: string) => app.schedules.runNow(filePath));
}
