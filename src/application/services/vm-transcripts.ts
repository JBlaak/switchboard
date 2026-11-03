/**
 * The Mac's copy of its VM sessions' transcripts (#276 stage 3, #292).
 *
 * A local session's row gets its title, first prompt, PR links and search text
 * from a transcript on the Mac's disk. A VM session's transcript is on the VM,
 * so this asks the host's agent for it (`get-transcript`) and keeps the answer:
 *
 * - **On every connect** to a host, every Claude session recorded on that
 *   host's projects is asked for. Shell sessions have no transcript.
 * - **On `transcripts-changed`** (the agent watches each file it was asked
 *   about) those sessions are asked for again.
 * - **A session recorded since** (one just started) is asked for the next time
 *   the project list is built while its host is connected, once per link.
 *
 * Each answer goes into a persisted cache, so rows keep their titles across a
 * restart and while the VM is off, and its text into the search index under
 * the session's id, where full-text search finds it as it finds a local one.
 * After a round of answers that changed anything, the renderer is told once
 * with `projectsChanged`: the same signal a transcript write on the Mac ends
 * in, which the renderer debounces into one list reload. The reload costs a
 * stat-only reconcile, not a rescan.
 *
 * Nothing here dials a host. A host that is not connected keeps its cached
 * rows as they were, and a tail of one of its sessions is empty: PR watch and
 * task detection poll, and must not start an ssh that may want a 1Password
 * approval nobody is looking at.
 */
import {agentHostKey} from './agent-client/agent-client';
import {nameToPersist, searchTitleFor, titleSourcesFor} from '../../domain/session/title';
import type {AgentConnection, UnaskedMessage} from './agent-client/agent-connection';
import type {AgentTranscript} from '../../domain/agent/protocol';
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {CachedSession, SessionPullRequest} from '../../domain/session/session';
import type {RemoteProjectSetting} from '../../domain/settings/settings';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {SearchIndex} from '../ports/search-index';
import type {SessionRepository} from '../ports/session-repository';
import type {VmTranscriptEntry, VmTranscriptStore} from '../ports/vm-transcript-store';

/**
 * The search index's folder for a host's sessions. Local sessions are indexed
 * under their transcript folder, which a re-index drops wholesale; a VM
 * session's entry must survive that, so it is kept under a folder no
 * transcript directory can be named.
 */
export function vmSearchFolder(hostKey: string): string {
    return `vm:${hostKey}`;
}

export interface VmTranscriptsDeps {
    agents: {
        onConnected(listener: (connection: AgentConnection) => void): void;
        connection(host: RemoteConfig): AgentConnection;
    };
    /** The remote projects and the sessions recorded on them. */
    remoteProjects(): readonly RemoteProjectSetting[];
    store: VmTranscriptStore;
    searchIndex: Pick<SearchIndex, 'upsert' | 'deleteSession'>;
    /** A rename the user typed outranks a transcript's titles in the search title; a CLI `/title` is kept as the name, as for a local session. */
    names: Pick<SessionRepository, 'getMeta' | 'setName'>;
    renderer: Pick<RendererGateway, 'projectsChanged'>;
    log: Logger;
}

/** A Claude session recorded on a VM project, and that project's host. */
interface RecordedSession {
    sessionId: string;
    remote: RemoteProjectSetting;
    hostKey: string;
}

export class VmTranscripts {
    private readonly entries = new Map<string, VmTranscriptEntry>();
    /** The connections whose `transcripts-changed` this listens to already. */
    private readonly listening = new WeakSet<AgentConnection>();
    /** Per host, the sessions asked for over its current link: a new link asks again. */
    private readonly asked = new Map<string, Set<string>>();

    constructor(private readonly deps: VmTranscriptsDeps) {
        for (const entry of deps.store.all()) this.entries.set(entry.sessionId, entry);
        deps.agents.onConnected((connection) => void this.connected(connection));
    }

    // ── Reading ──

    /** The session's transcript as last fetched; null for one never fetched (or not a VM session). */
    public get(sessionId: string): CachedSession | null {
        return this.entries.get(sessionId)?.transcript ?? null;
    }

    /** The folder the session ran in on the VM, as last fetched; null when unknown. */
    public cwd(sessionId: string): string | null {
        return this.entries.get(sessionId)?.cwd ?? null;
    }

    /** The PRs the session's transcript linked, as last fetched; empty when unknown. */
    public pullRequests(sessionId: string): SessionPullRequest[] {
        return this.entries.get(sessionId)?.transcript.pullRequests ?? [];
    }

    /**
     * The last `bytes` of the session's transcript, as lines, read through its
     * host's link. Empty when the host is not connected, the agent fails, or
     * the session is not recorded on any VM project. Never dials.
     */
    public async tail(sessionId: string, bytes: number): Promise<string[]> {
        const recorded = this.recorded().find((r) => r.sessionId === sessionId);
        if (!recorded) return [];
        const connection = this.deps.agents.connection(recorded.remote);
        if (!connection.connected) return [];
        try {
            return await connection.transcriptTail(sessionId, bytes);
        } catch (err) {
            this.deps.log.warn(`[vm-transcripts] tail of ${sessionId} failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * The cached transcripts of the sessions `remoteProjects` records, by id:
     * the project list's `vmTranscripts` input.
     *
     * Building the list is also where the cache meets the records, so two
     * chores ride along. An entry whose record is gone (its project removed,
     * its session forgotten) leaves the cache and the search index. A Claude
     * session recorded since its host connected (one just started there) is
     * asked for, in the background, when that host is connected now.
     */
    public forList(remoteProjects: readonly RemoteProjectSetting[]): ReadonlyMap<string, CachedSession> {
        const recorded = recordedSessions(remoteProjects);
        const ids = new Set(recorded.map((r) => r.sessionId));
        for (const sessionId of [...this.entries.keys()]) {
            if (!ids.has(sessionId)) this.forget(sessionId);
        }

        const unasked = recorded.filter((r) => {
            const asked = this.asked.get(r.hostKey);
            return asked !== undefined && !asked.has(r.sessionId);
        });
        if (unasked.length) void this.fetchRecorded(unasked);

        const rows = new Map<string, CachedSession>();
        for (const {sessionId} of recorded) {
            const entry = this.entries.get(sessionId);
            if (entry) rows.set(sessionId, entry.transcript);
        }
        return rows;
    }

    // ── Fetching ──

    /** A host (re)connected: listen to it, and ask for every Claude session recorded on it. */
    private async connected(connection: AgentConnection): Promise<void> {
        const hostKey = agentHostKey(connection.host);
        if (!this.listening.has(connection)) {
            this.listening.add(connection);
            connection.onMessage((message) => void this.unasked(connection, message));
        }
        // What was asked over an earlier link is asked again: the agent's watches went with it.
        this.asked.set(hostKey, new Set());
        const sessionIds = this.recorded()
            .filter((r) => r.hostKey === hostKey)
            .map((r) => r.sessionId);
        await this.fetchAndSignal(connection, sessionIds);
    }

    private async unasked(connection: AgentConnection, message: UnaskedMessage): Promise<void> {
        if (message.type !== 'transcripts-changed') return;
        const hostKey = agentHostKey(connection.host);
        // Only sessions still recorded on this host: a forgotten one is not asked for again.
        const recorded = new Set(
            this.recorded()
                .filter((r) => r.hostKey === hostKey)
                .map((r) => r.sessionId),
        );
        await this.fetchAndSignal(
            connection,
            message.sessionIds.filter((id) => recorded.has(id)),
        );
    }

    private async fetchRecorded(recorded: readonly RecordedSession[]): Promise<void> {
        const byHost = new Map<string, RecordedSession[]>();
        for (const r of recorded) byHost.set(r.hostKey, [...(byHost.get(r.hostKey) ?? []), r]);
        await Promise.all(
            [...byHost.values()].map((sessions) => {
                const connection = this.deps.agents.connection(sessions[0].remote);
                if (!connection.connected) return Promise.resolve();
                return this.fetchAndSignal(
                    connection,
                    sessions.map((s) => s.sessionId),
                );
            }),
        );
    }

    /** Ask for each session, then tell the renderer once if any answer was news. */
    private async fetchAndSignal(connection: AgentConnection, sessionIds: readonly string[]): Promise<void> {
        if (!sessionIds.length) return;
        const hostKey = agentHostKey(connection.host);
        const asked = this.asked.get(hostKey);
        for (const id of sessionIds) asked?.add(id);
        const changed = await Promise.all(sessionIds.map((id) => this.fetch(connection, hostKey, id)));
        if (changed.some(Boolean)) this.deps.renderer.projectsChanged();
    }

    /**
     * Ask for one session's transcript and keep it. Answers whether the cache
     * changed. A null answer (no transcript yet) or a failure keeps what was
     * cached: a row keeps its last title rather than falling back to "Remote
     * Claude" over a hiccup.
     */
    private async fetch(connection: AgentConnection, hostKey: string, sessionId: string): Promise<boolean> {
        let transcript: AgentTranscript | null;
        try {
            transcript = await connection.getTranscript(sessionId);
        } catch (err) {
            this.deps.log.warn(`[vm-transcripts] ${sessionId} on ${hostKey}: ${(err as Error).message}`);
            return false;
        }
        if (!transcript) return false;

        const previous = this.entries.get(sessionId);
        if (previous && previous.mtimeMs === transcript.mtimeMs && previous.hostKey === hostKey) return false;

        const {session} = transcript;
        const {textContent, customTitle, ...cached} = session;
        const entry: VmTranscriptEntry = {
            sessionId,
            hostKey,
            cwd: transcript.cwd,
            mtimeMs: transcript.mtimeMs,
            // Keyed by the id the Mac asked for, whatever the VM's parse called it.
            transcript: {...cached, sessionId},
        };
        this.entries.set(sessionId, entry);
        this.deps.store.put(entry);

        const {names, searchIndex} = this.deps;
        const name = nameToPersist({customTitle});
        if (name) names.setName(sessionId, name);
        searchIndex.upsert([
            {
                id: sessionId,
                type: 'session',
                folder: vmSearchFolder(hostKey),
                title: searchTitleFor(
                    titleSourcesFor({customTitle, aiTitle: session.aiTitle}, names.getMeta(sessionId)),
                    session.summary,
                ),
                body: textContent ?? '',
            },
        ]);
        return true;
    }

    private forget(sessionId: string): void {
        this.entries.delete(sessionId);
        this.deps.store.delete(sessionId);
        this.deps.searchIndex.deleteSession(sessionId);
    }

    private recorded(): RecordedSession[] {
        return recordedSessions(this.deps.remoteProjects());
    }
}

/**
 * Every Claude session recorded on a VM project. A remote without an agent
 * runs its sessions in tmux, with no agent to ask, and a shell has no
 * transcript. One session id is listed once, under the first project naming it.
 */
function recordedSessions(remoteProjects: readonly RemoteProjectSetting[]): RecordedSession[] {
    const seen = new Set<string>();
    const recorded: RecordedSession[] = [];
    for (const remote of remoteProjects) {
        if (!remote.agent) continue;
        const hostKey = agentHostKey(remote);
        for (const record of remote.sessions ?? []) {
            if (record.kind === 'shell' || seen.has(record.sessionId)) continue;
            seen.add(record.sessionId);
            recorded.push({sessionId: record.sessionId, remote, hostKey});
        }
    }
    return recorded;
}
