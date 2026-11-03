/**
 * Files dropped on a VM session's terminal (#276 stage 5): uploaded to the
 * session's VM, and the paths there answered for the renderer to type.
 *
 * The call goes to the `DroppedFiles` façade. Until the composition root
 * builds it, a drop answers an error, so nothing is typed.
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerDroppedFilesHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.droppedFilesToSession, async (sessionId: unknown, localPaths: unknown) => {
        if (typeof sessionId !== 'string' || sessionId === '') return {ok: false, error: 'No session to upload to'};
        const paths = Array.isArray(localPaths)
            ? localPaths.filter((path): path is string => typeof path === 'string' && path !== '')
            : [];
        if (paths.length === 0) return {ok: false, error: 'No files to upload'};
        if (!app.droppedFiles) return {ok: false, error: 'Uploading to a VM isn’t available in this build'};
        return app.droppedFiles.toSession(sessionId, paths);
    });
}
