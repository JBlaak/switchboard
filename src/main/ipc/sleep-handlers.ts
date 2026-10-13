/**
 * The Mac's "never sleep" switch, `pmset disablesleep`.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerSleepHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.getSleepDisabled, () => app.sleep.isSleepDisabled());
  ipc.handle(INVOKE.setSleepDisabled, (disabled: boolean) => app.sleep.setSleepDisabled(disabled));
}
