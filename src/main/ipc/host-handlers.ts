/**
 * The host capabilities the UI reaches for.
 */
import { INVOKE } from '../../ipc/channels';
import { repoWebUrl } from '../../domain/project/repo-url';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerHostHandlers(ipc: IpcRegistrar, app: Container): void {
  // ── Host ──
  ipc.handle(INVOKE.openExternal, (url: string) => app.system.openExternal(url));
  ipc.handle(INVOKE.openRepository, async (projectPath: string) => {
    if (typeof projectPath !== 'string' || projectPath.startsWith('ssh://')) return false;
    const remote = await app.git.originUrl(projectPath);
    const url = remote && repoWebUrl(remote);
    if (!url) return false;
    await app.system.openExternal(url);
    return true;
  });
  ipc.handle(INVOKE.writeClipboard, (text: string) => {
    app.system.writeClipboard(text);
  });
  ipc.handle(INVOKE.getAppVersion, () => app.system.appVersion());
}
