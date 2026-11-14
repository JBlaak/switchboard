/**
 * Catching up on the VM sessions that archived themselves on the VM (#308).
 *
 * A VM session keeps running with no Mac connected, and may call
 * `archive_session` then. The agent accepts the call itself, stops the session
 * when its turn ends and records it on the VM. A merging VM's fix errand that
 * finished is archived there the same way, Mac or no Mac (#442). This is the
 * Mac's half: on every connect to a host, and on every read of a merging VM's
 * lanes, it asks for that record, archives each row it knows the normal way,
 * and tells the agent to forget what it handled. Without the lane reads, an
 * errand that finished while the Mac was connected kept its row until the
 * link next came up.
 *
 * "The normal way" is the same archiver the archive tool uses, without its
 * stop: the session already stopped on the VM. So the row moves to Archived,
 * the window is told, the worktree cleanup runs when it is on, and the task
 * gets its line, exactly as for an archive made while the Mac was there.
 *
 * A session is known when a remote project on that host, with an agent,
 * records it. An id the Mac does not know (a row deleted meanwhile, or a
 * session started from another Mac) is forgotten too, with a log line: there
 * is no row to archive, and keeping it would only list it again on every
 * connect.
 *
 * Only an agent at the app's own version is asked. An older agent on the same
 * protocol does not know `list-self-archived`, and the router refuses an
 * unknown message by closing the link, so asking it would cost the host its
 * connection on every connect. It records nothing either, so nothing is lost.
 */
import type {SelfArchivedSession} from '../../domain/agent/protocol';
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {RemoteProjectSetting} from '../../domain/settings/settings';
import type {Logger} from '../ports/logger';
import {agentHostKey} from './agent-client/agent-client';
import type {AgentConnection} from './agent-client/agent-connection';

/** What the catch-up needs of a host's connection, just after its handshake. */
export type SelfArchiveSource = Pick<
    AgentConnection,
    'host' | 'target' | 'agentVersion' | 'listSelfArchived' | 'forgetSelfArchived'
>;

export interface SelfArchiveCatchUpDeps {
    /** The app's version: only an agent at it knows the self-archive messages. */
    appVersion: string;
    /** The remote projects, with the sessions recorded on each. */
    remoteProjects(): readonly RemoteProjectSetting[];
    /**
     * The archive tool's archiver (`sessionArchiver`), its stop-less half: the
     * row archived, the window told, the worktree cleanup and the task line.
     */
    archiver: {archiveStopped(sessionId: string): void};
    log: Logger;
}

export class SelfArchiveCatchUp {
    /** Hosts a catch-up is under way for: a lane read during a connect's catch-up is skipped. */
    private readonly running = new Set<string>();

    constructor(private readonly deps: SelfArchiveCatchUpDeps) {}

    /**
     * Archive the rows of the sessions that archived themselves on this host,
     * then have the agent forget them. Never throws; a failure is logged, and
     * the record stays for the next catch-up.
     */
    public async catchUp(connection: SelfArchiveSource): Promise<void> {
        if (connection.agentVersion !== this.deps.appVersion) return;
        const key = agentHostKey(connection.host);
        if (this.running.has(key)) return;
        this.running.add(key);
        try {
            await this.handle(connection);
        } finally {
            this.running.delete(key);
        }
    }

    private async handle(connection: SelfArchiveSource): Promise<void> {
        const {archiver, log} = this.deps;
        let sessions: SelfArchivedSession[];
        try {
            sessions = await connection.listSelfArchived();
        } catch (err) {
            log.warn(
                `[self-archive] could not list ${connection.target}'s self-archived sessions: ${(err as Error).message}`,
            );
            return;
        }
        if (sessions.length === 0) return;

        const handled: string[] = [];
        for (const {sessionId, archivedAt} of sessions) {
            if (this.knows(connection.host, sessionId)) {
                archiver.archiveStopped(sessionId);
                log.info(
                    `[self-archive] session=${sessionId} archived itself on ${connection.target} at ${new Date(archivedAt).toISOString()}; row archived`,
                );
            } else {
                log.info(
                    `[self-archive] session=${sessionId} on ${connection.target} is not known here; forgetting it`,
                );
            }
            handled.push(sessionId);
        }

        try {
            const done = await connection.forgetSelfArchived(handled);
            if (!done.ok) log.warn(`[self-archive] ${connection.target} could not forget: ${done.error ?? ''}`);
        } catch (err) {
            // Listed again on the next catch-up; archiving a row twice is harmless.
            log.warn(`[self-archive] could not tell ${connection.target} to forget: ${(err as Error).message}`);
        }
    }

    /** Whether a remote project on `host`, with an agent, records `sessionId`. */
    private knows(host: RemoteConfig, sessionId: string): boolean {
        const key = agentHostKey(host);
        return this.deps
            .remoteProjects()
            .some(
                (remote) =>
                    !!remote.agent &&
                    agentHostKey(remote) === key &&
                    !!remote.sessions?.some((record) => record.sessionId === sessionId),
            );
    }
}
