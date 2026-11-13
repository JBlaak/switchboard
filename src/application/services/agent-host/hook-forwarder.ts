/**
 * The agent's question hook and archive tool, forwarding to the Mac (#276, #278).
 *
 * A session on the VM is launched with the same hooks and archive tool as a
 * local one, pointed at a `QuestionHookServer` the agent runs on its own
 * 127.0.0.1. That server does not answer anything itself: this part is its
 * `receiver` and `archiveTool`, and turns what the CLI posts into messages to
 * the Mac, whose QuestionService and ArchiveToolService stay the ones that
 * decide. The Mac finds the session by the `launchId` alone, exactly as it
 * does for a local session, so nothing about the forwarding leaks into it.
 *
 * What is held, and where it goes:
 * - An ask is the one thing the CLI waits on. It is kept here under a fresh
 *   `hookId` until the Mac sends `ask-reply`; the CLI giving up first sends
 *   `ask-withdrawn` instead. With no client, or once its client goes, it is
 *   released with no decision, so the CLI asks in its own terminal: a VM
 *   session must never sit frozen on a question nobody can see.
 * - An archive call is held the same way, but only briefly
 *   (ARCHIVE_REPLY_TIMEOUT_MS): it is an MCP tool call, and a session waiting
 *   minutes on one is worse than a tool that hangs.
 * - With no client to ask (none connected, or its answer did not come in
 *   time, or it went away first), the archive call is accepted here instead
 *   (#308): see "Archiving while the Mac is away" below.
 * - Ended turns (the text blocks the agent's hook server read from the
 *   transcript on the VM), prompt submits, subagent starts and stops, and turn
 *   ends for the archive tool are notices. The CLI was already answered, so
 *   they are sent if a client is there and dropped if not.
 *
 * "The client" is the most recently connected one still open. The Mac is the
 * only client in practice, and a second connection is almost always the same
 * Mac reconnecting before the old link noticed it was dead, so the newest one
 * is the one worth talking to. What an older client still holds stays with it
 * until it answers or goes.
 *
 * Archiving while the Mac is away (#308). A VM session runs on with no Mac,
 * so it may call `archive_session` when nobody is there to answer. The call is
 * then accepted here and remembered as pending for that session. When its turn
 * ends, the rule is decided by whether a client is connected *then*:
 * - None: the agent archives it on the VM itself. The session is stopped
 *   (SIGTERM to its tree, as the Mac's stop does) and `{sessionId, archivedAt}`
 *   is added to the self-archive record (SELF_ARCHIVED_FILE), which outlives
 *   an agent restart. On its next connect the Mac lists that record
 *   (`list-self-archived`), archives the rows it knows the normal way, and
 *   clears them (`forget-self-archived`).
 * - One arrived meanwhile: the Mac does it, exactly as for a call made while
 *   it was connected. The agent sends it the `archive-request` it missed (its
 *   reply is dropped: the CLI was answered long ago), then `turn-ended`, so the
 *   Mac's archive tool marks the session and archives it on the same notice.
 * A pending archive lives in memory only: the sessions are the agent's own
 * children, so an agent restart ends them along with what was pending.
 *
 * In-process listeners (#438). The agent's own services, the Merge manager's
 * fix errands above all, need to hear a session's turn end and its
 * `archive_session` call whether or not a Mac is connected. `subscribe` hands
 * them both, beside (never instead of) what goes to the Mac.
 */
import {archiveToolMcpConfig, ARCHIVE_TOOL_QUALIFIED_NAME} from '../../../domain/session/archive-tool';
import type {ArchiveToolOutcome} from '../../../domain/session/archive-tool';
import {QUESTION_HOOK_TOKEN_HEADER, questionHookSettings} from '../../../domain/questions/question';
import type {AskedQuestions} from '../../../domain/questions/question';
import type {SessionTools} from '../../../domain/launch/claude-command';
import type {
    ForgetSelfArchivedMessage,
    GrillTurnMessage,
    PromptSubmittedMessage,
    SelfArchivedSession,
    SubagentMessage,
    TurnEndedMessage,
} from '../../../domain/agent/protocol';
import type {ClientLink} from '../../ports/agent-link';
import type {Clock, Timers, TimerHandle} from '../../ports/clock';
import type {IdGenerator} from '../../ports/ids';
import type {Logger} from '../../ports/logger';
import type {HookReceiver, QuestionHookEndpoint} from '../../ports/question-hook';
import type {PendingQuestionsHandle, QuestionReply} from '../question-service';
import type {HookForwarderMessage, HookForwarderPart} from './handlers';

/**
 * How long an archive call waits for the Mac. The Mac answers at once (it only
 * marks the session), so anything near this means the link is dead and not
 * yet noticed; ten seconds keeps the tool call from looking hung.
 */
export const ARCHIVE_REPLY_TIMEOUT_MS = 10_000;

/** The reply that makes no decision: the CLI asks in its own terminal. */
const NO_DECISION: Record<string, unknown> = {};

/** The answer when the agent takes the archive on itself, with no Mac to ask (#308). */
export const SELF_ARCHIVE_OUTCOME: ArchiveToolOutcome = {
    ok: true,
    message: 'This session will be archived when this turn ends.',
};

/**
 * The self-archive record on the VM (SELF_ARCHIVED_FILE), as raw text: a JSON
 * array of SelfArchivedSession. A port so the forwarder stays testable and the
 * application layer does no file I/O.
 */
export interface SelfArchivedFile {
    /** The file's text, or null when it does not exist or cannot be read. */
    read(): string | null;
    /** Replace the file's text, atomically and mode 0600; may throw. */
    write(text: string): void;
}

/** An agent-side service hearing sessions' turn ends and archive calls, Mac or no Mac (#438). */
export interface SessionHookListener {
    /** A session's turn ended (its Stop hook). */
    turnEnded?(launchId: string): void;
    /** A session called `archive_session`. */
    archiveRequested?(launchId: string): void;
}

/** What the hook server hands archive tool calls and turn ends to; its `archiveTool` dep. */
export interface HookArchiveTool {
    request(launchId: string): Promise<ArchiveToolOutcome>;
    turnEnded(launchId: string): void;
}

export interface HookForwarderDeps {
    /**
     * The agent's own hook server, for the URLs and token a launch is given.
     * Read at launch time, not at construction, so it may be the server built
     * after this part (see the getter wiring in the integration notes).
     */
    endpoint: QuestionHookEndpoint;
    timers: Timers;
    /** The `hookId` of each forwarded ask and archive call. */
    ids: IdGenerator;
    log: Logger;
    /**
     * Stop the session launched as `launchId` (SIGTERM to its process tree), for
     * an archive made with no Mac connected. The session host's `stop`.
     */
    stop(launchId: string): void;
    /** Where sessions that archived themselves with no Mac connected are recorded. */
    selfArchived: SelfArchivedFile;
    /** For a record's `archivedAt`. */
    clock: Clock;
    /** Overrides ARCHIVE_REPLY_TIMEOUT_MS, for tests. */
    archiveTimeoutMs?: number;
}

interface HeldAsk {
    client: ClientLink;
    reply: QuestionReply;
}

interface HeldArchive {
    client: ClientLink;
    launchId: string;
    timer: TimerHandle;
    resolve(outcome: ArchiveToolOutcome): void;
}

export class HookForwarder implements HookForwarderPart {
    /** Connected clients, oldest first; the last is the one asks go to. */
    private readonly clients: ClientLink[] = [];
    private readonly asks = new Map<string, HeldAsk>();
    private readonly archives = new Map<string, HeldArchive>();
    /** Sessions (by launch id) whose archive call was accepted here, archived when their turn ends. */
    private readonly selfArchives = new Set<string>();
    private readonly listeners: SessionHookListener[] = [];

    /** Give this to the agent's `QuestionHookServer` as its `receiver`. */
    public readonly receiver: HookReceiver = {
        receive: (launchId, asked, reply) => this.receive(launchId, asked, reply),
        turnEnded: (launchId, turn, backgroundAgents) =>
            this.notify({type: 'grill-turn', launchId, turn, backgroundAgents}),
        promptSubmitted: (launchId, prompt) => this.notify({type: 'prompt-submitted', launchId, prompt}),
        subagentChanged: (launchId, event, agentId) => this.notify({type: 'subagent', launchId, event, agentId}),
    };

    /** Give this to the agent's `QuestionHookServer` as its `archiveTool`. */
    public readonly archiveTool: HookArchiveTool = {
        request: (launchId) => this.requestArchive(launchId),
        turnEnded: (launchId) => this.turnEnded(launchId),
    };

    constructor(private readonly deps: HookForwarderDeps) {}

    /** Hear every session's turn ends and archive calls in-process, whether or not a Mac is connected. */
    public subscribe(listener: SessionHookListener): void {
        this.listeners.push(listener);
    }

    public clientConnected(client: ClientLink): void {
        if (!this.clients.includes(client)) this.clients.push(client);
    }

    /** Release everything the client held: its asks with no decision, its archive calls accepted here. */
    public clientGone(client: ClientLink): void {
        const index = this.clients.indexOf(client);
        if (index >= 0) this.clients.splice(index, 1);
        for (const [hookId, held] of [...this.asks]) {
            if (held.client !== client) continue;
            this.asks.delete(hookId);
            held.reply(NO_DECISION);
        }
        for (const [hookId, held] of [...this.archives]) {
            if (held.client === client) this.settleArchive(hookId, held, this.acceptSelfArchive(held.launchId));
        }
    }

    /**
     * An answer from the Mac. Only the client an ask or call was sent to may
     * answer it; a reply for anything else (already withdrawn, timed out, or
     * sent elsewhere) is dropped.
     */
    public handle(client: ClientLink, message: HookForwarderMessage): void {
        if (message.type === 'list-self-archived') {
            client.send({type: 'self-archived', requestId: message.requestId, sessions: this.readRecords()});
            return;
        }
        if (message.type === 'forget-self-archived') {
            this.forget(client, message);
            return;
        }
        if (message.type === 'ask-reply') {
            const held = this.asks.get(message.hookId);
            if (!held || held.client !== client) return;
            this.asks.delete(message.hookId);
            held.reply(message.json);
            return;
        }
        const held = this.archives.get(message.hookId);
        if (!held || held.client !== client) return;
        this.settleArchive(message.hookId, held, message.outcome);
    }

    /** The same hooks a local launch gets, pointed at the agent's own server. */
    public settingsFor(launchId: string): string | null {
        const {url, token} = this.deps.endpoint;
        if (!url) return null;
        const id = encodeURIComponent(launchId);
        return questionHookSettings(
            {
                ask: `${url}/ask/${id}`,
                stop: `${url}/stop/${id}`,
                prompt: `${url}/prompt/${id}`,
                subagent: `${url}/subagent/${id}`,
            },
            token,
        );
    }

    /** The same archive tool a local launch gets, pointed at the agent's own server. */
    public toolsFor(launchId: string): SessionTools | null {
        const {url, token} = this.deps.endpoint;
        if (!url) return null;
        return {
            mcpConfig: archiveToolMcpConfig(`${url}/mcp/${encodeURIComponent(launchId)}`, {
                [QUESTION_HOOK_TOKEN_HEADER]: token,
            }),
            allowedTools: [ARCHIVE_TOOL_QUALIFIED_NAME],
        };
    }

    private receive(launchId: string, asked: AskedQuestions, reply: QuestionReply): PendingQuestionsHandle {
        const client = this.current();
        if (!client) {
            reply(NO_DECISION);
            return {withdraw() {}};
        }
        const hookId = this.deps.ids.newId();
        this.asks.set(hookId, {client, reply});
        client.send({type: 'ask', hookId, launchId, asked});
        return {
            withdraw: () => {
                const held = this.asks.get(hookId);
                if (!held) return;
                this.asks.delete(hookId);
                if (!held.client.closed) held.client.send({type: 'ask-withdrawn', hookId});
            },
        };
    }

    private requestArchive(launchId: string): Promise<ArchiveToolOutcome> {
        this.tell(launchId, 'archiveRequested');
        const client = this.current();
        if (!client) return Promise.resolve(this.acceptSelfArchive(launchId));
        const hookId = this.deps.ids.newId();
        return new Promise((resolve) => {
            const timer = this.deps.timers.setTimeout(() => {
                const held = this.archives.get(hookId);
                if (!held) return;
                this.deps.log.warn(`[agent-hooks] archive call for ${launchId} timed out; archiving it here`);
                this.settleArchive(hookId, held, this.acceptSelfArchive(launchId));
            }, this.deps.archiveTimeoutMs ?? ARCHIVE_REPLY_TIMEOUT_MS);
            this.archives.set(hookId, {client, launchId, timer, resolve});
            client.send({type: 'archive-request', hookId, launchId});
        });
    }

    private settleArchive(hookId: string, held: HeldArchive, outcome: ArchiveToolOutcome): void {
        this.archives.delete(hookId);
        this.deps.timers.clearTimeout(held.timer);
        held.resolve(outcome);
    }

    /** Take an archive call on here, with no Mac to answer it: done when the session's turn ends. */
    private acceptSelfArchive(launchId: string): ArchiveToolOutcome {
        this.selfArchives.add(launchId);
        this.deps.log.info(`[agent-hooks] session=${launchId} asked to be archived with no Mac; archiving it here`);
        return SELF_ARCHIVE_OUTCOME;
    }

    /**
     * A turn ended. A session whose archive call was accepted here is archived
     * on the VM when no client is connected now; when one arrived meanwhile, it
     * is handed the missed `archive-request` and then the `turn-ended`, so the
     * Mac archives it as if it had been there all along (see the file header).
     */
    private turnEnded(launchId: string): void {
        this.tell(launchId, 'turnEnded');
        if (this.selfArchives.delete(launchId)) {
            const client = this.current();
            if (!client) {
                this.archiveHere(launchId);
                return;
            }
            client.send({type: 'archive-request', hookId: this.deps.ids.newId(), launchId});
        }
        this.notify({type: 'turn-ended', launchId});
    }

    /** Stop the session and record it, for the Mac to archive its row on its next connect. */
    private archiveHere(launchId: string): void {
        this.deps.stop(launchId);
        const records = this.readRecords().filter((record) => record.sessionId !== launchId);
        records.push({sessionId: launchId, archivedAt: this.deps.clock.now()});
        try {
            this.writeRecords(records);
            this.deps.log.info(`[agent-hooks] session=${launchId} stopped and recorded as archived`);
        } catch (err) {
            // The session is stopped either way; only the Mac's row stays as it is.
            this.deps.log.error(`[agent-hooks] could not record session=${launchId} as archived`, err);
        }
    }

    /** Drop the sessions the Mac has handled from the record; answered with `done`. */
    private forget(client: ClientLink, message: ForgetSelfArchivedMessage): void {
        const forgotten = new Set(message.sessionIds);
        const records = this.readRecords();
        const kept = records.filter((record) => !forgotten.has(record.sessionId));
        try {
            if (kept.length !== records.length) this.writeRecords(kept);
            client.send({type: 'done', requestId: message.requestId, ok: true});
        } catch (err) {
            client.send({type: 'done', requestId: message.requestId, ok: false, error: (err as Error).message});
        }
    }

    /**
     * The self-archive record. A missing, unreadable or malformed file reads as
     * empty, and malformed entries are skipped: the record is a convenience for
     * the Mac's rows, and must never stop the archive tool from working.
     */
    private readRecords(): SelfArchivedSession[] {
        const text = this.deps.selfArchived.read();
        if (!text) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            this.deps.log.warn('[agent-hooks] the self-archive record is not JSON; reading it as empty');
            return [];
        }
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (entry): entry is SelfArchivedSession =>
                typeof entry === 'object' &&
                entry !== null &&
                typeof (entry as SelfArchivedSession).sessionId === 'string' &&
                typeof (entry as SelfArchivedSession).archivedAt === 'number',
        );
    }

    private writeRecords(records: SelfArchivedSession[]): void {
        this.deps.selfArchived.write(JSON.stringify(records, null, 2) + '\n');
    }

    /** A notice the CLI was already answered for: to the client if there is one, else dropped. */
    private notify(message: GrillTurnMessage | PromptSubmittedMessage | SubagentMessage | TurnEndedMessage): void {
        const client = this.current();
        if (client) client.send(message);
        else this.deps.log.debug(`[agent-hooks] no client; dropped ${message.type} for ${message.launchId}`);
    }

    /** Tell the in-process listeners; one that throws is logged and the rest still hear it. */
    private tell(launchId: string, event: keyof SessionHookListener): void {
        for (const listener of this.listeners) {
            try {
                listener[event]?.(launchId);
            } catch (err) {
                this.deps.log.error(`[agent-hooks] a listener failed on ${event} for ${launchId}`, err);
            }
        }
    }

    /** The most recently connected client whose link is still open. */
    private current(): ClientLink | null {
        for (let i = this.clients.length - 1; i >= 0; i--) {
            if (!this.clients[i].closed) return this.clients[i];
        }
        return null;
    }
}
