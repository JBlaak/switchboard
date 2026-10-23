/**
 * Phone access (#194): the Settings section, the pairing dialog and the
 * terminal placeholder's Use here.
 *
 * Every Phone access call answers the whole snapshot, as the pushes do.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerPhoneAccessHandlers(ipc: IpcRegistrar, app: Container): void {
  const { phoneAccess, phoneSessions } = app;
  ipc.handle(INVOKE.phoneAccessGet, () => phoneAccess.state());
  ipc.handle(INVOKE.phoneAccessSetEnabled, (enabled: boolean) => phoneAccess.setEnabled(enabled === true));
  ipc.handle(INVOKE.phoneAccessStartPairing, () => phoneAccess.startPairing());
  ipc.handle(INVOKE.phoneAccessStopPairing, () => phoneAccess.stopPairing());
  ipc.handle(INVOKE.phoneAccessConfirmPairing, (requestId: string, accept: boolean) =>
    phoneAccess.confirmPairing(requestId, accept === true));
  ipc.handle(INVOKE.phoneAccessRevoke, (deviceId: string) => phoneAccess.revoke(deviceId));
  ipc.handle(INVOKE.phoneAccessReset, () => phoneAccess.reset());

  ipc.handle(INVOKE.terminalOwners, () => phoneSessions.owners());
  // The Mac takes the session back. The renderer sends its size straight
  // after (`reclaimTerminal`), and that resize is the Mac's now, so it lands.
  ipc.handle(INVOKE.useTerminalHere, (sessionId: string) => phoneSessions.useHereOnMac(sessionId));
}
