/**
 * A newer release, and installing it.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerUpdateHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.getUpdate, () => app.updates.notice());
  ipc.handle(INVOKE.installUpdate, () => app.updates.install());
}
