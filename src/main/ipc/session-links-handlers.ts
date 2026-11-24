/**
 * A session's links for the session tray (#340): its PRs, issues, artifacts,
 * pages and task, answered from what main keeps.
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';
import type {LinksWait} from '../../domain/session/links';

export function registerSessionLinksHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.sessionLinks, (sessionId: string, wait?: unknown) =>
        typeof sessionId === 'string' && sessionId ? app.sessionLinks.links(sessionId, linksWait(wait)) : [],
    );
}

/** What the renderer asked the answer to wait for; the default for anything else. */
function linksWait(wait: unknown): LinksWait | undefined {
    return wait === 'nothing' || wait === 'everything' || wait === 'issues' ? wait : undefined;
}
