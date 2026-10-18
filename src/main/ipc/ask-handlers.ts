/**
 * Ask Patch: route what the user typed on the empty screen, or stop routing it.
 */
import { INVOKE } from '../../ipc/channels';
import type { RouteRequest } from '../../domain/ask/model';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerAskHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.askRoute, (request: RouteRequest) => app.askRoute.route(request));
  ipc.handle(INVOKE.cancelAskRoute, () => app.askRoute.cancel());
}
