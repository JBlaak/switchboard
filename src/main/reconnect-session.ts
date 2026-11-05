/**
 * "Retry now" on a session's connection card.
 */
import {isAgentPty} from '../application/services/agent-client/agent-pty';
import type {Container} from './composition-root';

/** What reconnecting needs. */
export type SessionReconnector = Pick<Container, 'registry' | 'remote'> & {
    agents: Pick<Container['agents'], 'retryHostOf'>;
};

export interface ReconnectResult {
    ok: boolean;
    error?: string;
    alreadyConnected?: boolean;
}

/**
 * Dial a session's connection again, now.
 *
 * A legacy remote session (ssh+tmux) has its own connection, which the
 * supervisor redials. A VM session (#276) has no `remote` record: its
 * connection is its host's agent link, kept by the agent client, so that link
 * is what dials again, and every session on the host comes back with it.
 *
 * `ok: false` means there was nothing here to dial: the renderer then opens
 * the session afresh, which is the way back for one main already let go of.
 */
export function reconnectSession(app: SessionReconnector, sessionId: string): ReconnectResult {
    const session = app.registry.find(sessionId)?.session;
    if (session && isAgentPty(session.pty)) return app.agents.retryHostOf(session.pty);
    return app.remote.retryNow(sessionId);
}
