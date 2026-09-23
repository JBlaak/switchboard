/**
 * The viewer panel's file access, and the host capabilities the UI reaches for.
 *
 * The panel's paths come from the renderer, which got them from the CLI over
 * MCP or from a link in terminal output — so a write only ever overwrites a
 * file that already exists, and never creates one.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerHostHandlers(ipc: IpcRegistrar, app: Container): void {
  // ── The viewer panel ──
  ipc.handle(INVOKE.readFileForPanel, (filePath: string) => {
    try {
      return { ok: true, content: app.fs.readText(filePath) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipc.handle(INVOKE.saveFileForPanel, (filePath: string, content: string) => {
    const resolved = app.fs.resolve(filePath);
    if (!app.fs.exists(resolved)) return { ok: false, error: 'File does not exist' };
    try {
      app.fs.writeText(resolved, content);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipc.handle(INVOKE.watchFile, (filePath: string) => app.fileWatches.watch(filePath));
  ipc.handle(INVOKE.unwatchFile, (filePath: string) => {
    app.fileWatches.unwatch(filePath);
    return { ok: true };
  });

  // ── Host ──
  ipc.handle(INVOKE.openExternal, (url: string) => app.system.openExternal(url));
  ipc.handle(INVOKE.writeClipboard, (text: string) => {
    app.system.writeClipboard(text);
  });
  ipc.handle(INVOKE.getAppVersion, () => app.system.appVersion());

  ipc.handle(INVOKE.updaterCheck, () => app.updater.check());
  ipc.handle(INVOKE.updaterDownload, () => app.updater.download());
  ipc.handle(INVOKE.updaterInstall, () => {
    app.updater.install();
  });
}
