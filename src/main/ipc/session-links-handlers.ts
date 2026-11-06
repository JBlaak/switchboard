/**
 * A session's links for the session tray (#340): its PRs, issues, artifacts,
 * pages and task, answered from what main keeps.
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerSessionLinksHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.sessionLinks, (sessionId: string) =>
        typeof sessionId === 'string' && sessionId ? app.sessionLinks.links(sessionId) : [],
    );
}
