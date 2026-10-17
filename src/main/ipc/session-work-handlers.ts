/**
 * The Session work page: opening and closing it, whether it can open, an
 * item's diff and the images in it, and handing an item to Claude. Its snapshots are pushed, not
 * asked for.
 */
import { INVOKE, SEND } from '../../ipc/channels';
import type { ActionRequest } from '../../domain/session-work/actions';
import type { CommentRequest, ReviewRequest } from '../../domain/session-work/review';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerSessionWorkHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.sessionWorkOpen, (sessionId: string) => app.sessionWork.open(sessionId));
  ipc.handle(INVOKE.sessionWorkCanOpen, (sessionId: string) => app.sessionWork.canOpen(sessionId));
  ipc.handle(INVOKE.sessionWorkDiff, (request: { sessionId: string; itemId: string }) =>
    app.sessionWork.diff(request.sessionId, request.itemId));
  ipc.handle(INVOKE.sessionWorkImage, (request: { sessionId: string; itemId: string; path: string; side: string }) => {
    if (request?.side !== 'before' && request?.side !== 'after') return null;
    return app.sessionWork.image(String(request.sessionId), String(request.itemId), String(request.path), request.side);
  });
  ipc.handle(INVOKE.sessionWorkAction, (request: ActionRequest) =>
    app.sessionActions.request(request.sessionId, request.itemId, request.action, 'manual', { threadIds: threadIdsOf(request) }));
  ipc.handle(INVOKE.sessionWorkCancel, (activityId: string) => app.sessionActions.cancel(activityId));
  ipc.handle(INVOKE.sessionWorkComment, (request: CommentRequest) => app.review.comment(request));
  ipc.handle(INVOKE.sessionWorkReview, (request: ReviewRequest) => {
    if (request?.mode !== 'fix' && request?.mode !== 'submit' && request?.mode !== 'discard') {
      return { ok: false, reason: 'Unknown review mode' };
    }
    return app.review.review(request);
  });
  ipc.on(SEND.sessionWorkClose, (sessionId: string) => app.sessionWork.close(sessionId));
  ipc.handle(INVOKE.sessionWorkCheckLog, (request: { repository: string; checkRunUrl: string }) =>
    app.prWatch.checkLog(String(request?.repository ?? ''), String(request?.checkRunUrl ?? '')));
}

/** The threads a Fix comments names, when it names any: strings only. */
function threadIdsOf(request: ActionRequest): string[] | undefined {
  if (!Array.isArray(request.threadIds)) return undefined;
  return request.threadIds.filter((id): id is string => typeof id === 'string');
}
