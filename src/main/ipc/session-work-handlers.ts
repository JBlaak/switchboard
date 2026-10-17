/**
 * The Session work page: opening and closing it, whether it can open, an
 * item's diff, and handing an item to Claude. Its snapshots are pushed, not
 * asked for.
 */
import { INVOKE, SEND } from '../../ipc/channels';
import type { ActionRequest } from '../../domain/session-work/actions';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerSessionWorkHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.sessionWorkOpen, (sessionId: string) => app.sessionWork.open(sessionId));
  ipc.handle(INVOKE.sessionWorkCanOpen, (sessionId: string) => app.sessionWork.canOpen(sessionId));
  ipc.handle(INVOKE.sessionWorkDiff, (request: { sessionId: string; itemId: string }) =>
    app.sessionWork.diff(request.sessionId, request.itemId));
  ipc.handle(INVOKE.sessionWorkAction, (request: ActionRequest) =>
    app.sessionActions.request(request.sessionId, request.itemId, request.action));
  ipc.handle(INVOKE.sessionWorkCancel, (activityId: string) => app.sessionActions.cancel(activityId));
  ipc.on(SEND.sessionWorkClose, (sessionId: string) => app.sessionWork.close(sessionId));
  ipc.handle(INVOKE.sessionWorkCheckLog, (request: { repository: string; checkRunUrl: string }) =>
    app.prWatch.checkLog(String(request?.repository ?? ''), String(request?.checkRunUrl ?? '')));
}
