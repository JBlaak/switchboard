/**
 * The Session work page: opening and closing it, whether it can open, an
 * item's diff and the images in it, and your review. Its snapshots are pushed, not
 * asked for. A page id is a session's, or a PR's own (`pull:owner/repo#N`) for a
 * PR no session opened; the router tells them apart.
 */
import {INVOKE, SEND} from '../../ipc/channels';
import type {CommentRequest, ReviewRequest} from '../../domain/session-work/review';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerSessionWorkHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.sessionWorkOpen, (sessionId: string) => app.workPages.open(sessionId));
    ipc.handle(INVOKE.sessionWorkCanOpen, (sessionId: string) => app.workPages.canOpen(sessionId));
    ipc.handle(INVOKE.sessionWorkDiff, (request: {sessionId: string; itemId: string}) =>
        app.workPages.diff(request.sessionId, request.itemId),
    );
    ipc.handle(INVOKE.sessionWorkImage, (request: {sessionId: string; itemId: string; path: string; side: string}) => {
        if (request?.side !== 'before' && request?.side !== 'after') return null;
        return app.workPages.image(
            String(request.sessionId),
            String(request.itemId),
            String(request.path),
            request.side,
        );
    });
    ipc.handle(INVOKE.sessionWorkComment, (request: CommentRequest) => app.review.comment(request));
    ipc.handle(INVOKE.sessionWorkReview, (request: ReviewRequest) => {
        if (request?.mode !== 'submit' && request?.mode !== 'discard') {
            return {ok: false, reason: 'Unknown review mode'};
        }
        return app.review.review(request);
    });
    ipc.on(SEND.sessionWorkClose, (sessionId: string) => app.workPages.close(sessionId));
    ipc.handle(INVOKE.sessionWorkCheckLog, (request: {repository: string; checkRunUrl: string}) =>
        app.prWatch.checkLog(String(request?.repository ?? ''), String(request?.checkRunUrl ?? '')),
    );
}
