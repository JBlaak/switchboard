/**
 * The host capabilities the UI reaches for.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerHostHandlers(ipc: IpcRegistrar, app: Container): void {
  // ── Host ──
  ipc.handle(INVOKE.openExternal, (url: string) => app.system.openExternal(url));
  ipc.handle(INVOKE.writeClipboard, (text: string) => {
    app.system.writeClipboard(text);
  });
  ipc.handle(INVOKE.getAppVersion, () => app.system.appVersion());
}
