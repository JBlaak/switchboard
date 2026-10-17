/**
 * The Session work page: opening and closing it, whether it can open, and an
 * item's diff. Its snapshots are pushed, not asked for.
 */
import { INVOKE, SEND } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerSessionWorkHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.sessionWorkOpen, (sessionId: string) => app.sessionWork.open(sessionId));
  ipc.handle(INVOKE.sessionWorkCanOpen, (sessionId: string) => app.sessionWork.canOpen(sessionId));
  ipc.handle(INVOKE.sessionWorkDiff, (request: { sessionId: string; itemId: string }) =>
    app.sessionWork.diff(request.sessionId, request.itemId));
  ipc.on(SEND.sessionWorkClose, (sessionId: string) => app.sessionWork.close(sessionId));
}
