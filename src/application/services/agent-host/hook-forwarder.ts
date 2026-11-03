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
 *   minutes on one is worse than a tool that says it could not reach the Mac.
 * - Grill rounds, prompt submits and turn ends are notices. The CLI was
 *   already answered, so they are sent if a client is there and dropped if not.
 *
 * "The client" is the most recently connected one still open. The Mac is the
 * only client in practice, and a second connection is almost always the same
 * Mac reconnecting before the old link noticed it was dead, so the newest one
 * is the one worth talking to. What an older client still holds stays with it
 * until it answers or goes.
 */
import {archiveToolMcpConfig, ARCHIVE_TOOL_QUALIFIED_NAME} from '../../../domain/session/archive-tool';
import type {ArchiveToolOutcome} from '../../../domain/session/archive-tool';
import {QUESTION_HOOK_TOKEN_HEADER, questionHookSettings} from '../../../domain/questions/question';
import type {AskedQuestions, Question} from '../../../domain/questions/question';
import type {SessionTools} from '../../../domain/launch/claude-command';
import type {GrillRoundMessage, PromptSubmittedMessage, TurnEndedMessage} from '../../../domain/agent/protocol';
import type {ClientLink} from '../../ports/agent-link';
import type {Timers, TimerHandle} from '../../ports/clock';
import type {IdGenerator} from '../../ports/ids';
import type {Logger} from '../../ports/logger';
import type {QuestionHookEndpoint} from '../../ports/question-hook';
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

const NO_CLIENT_OUTCOME: ArchiveToolOutcome = {
    ok: false,
    message: "Switchboard on the Mac isn't connected to this VM right now, so nothing was archived.",
};

const TIMED_OUT_OUTCOME: ArchiveToolOutcome = {
    ok: false,
    message: "Switchboard on the Mac didn't answer in time, so nothing was archived.",
};

const CLIENT_GONE_OUTCOME: ArchiveToolOutcome = {
    ok: false,
    message: 'The connection to Switchboard on the Mac closed before it answered, so nothing was archived.',
};

/**
 * What the hook server hands questions and notices to. Structurally the same
 * slice of QuestionService the server's `receiver` dep takes, declared here so
 * the application layer does not import the HTTP adapter.
 */
export interface HookReceiver {
    receive(launchId: string, asked: AskedQuestions, reply: QuestionReply): PendingQuestionsHandle;
    receiveRound(launchId: string, questions: Question[]): void;
    promptSubmitted(launchId: string): void;
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
    /** Overrides ARCHIVE_REPLY_TIMEOUT_MS, for tests. */
    archiveTimeoutMs?: number;
}

interface HeldAsk {
    client: ClientLink;
    reply: QuestionReply;
}

interface HeldArchive {
    client: ClientLink;
    timer: TimerHandle;
    resolve(outcome: ArchiveToolOutcome): void;
}

export class HookForwarder implements HookForwarderPart {
    /** Connected clients, oldest first; the last is the one asks go to. */
    private readonly clients: ClientLink[] = [];
    private readonly asks = new Map<string, HeldAsk>();
    private readonly archives = new Map<string, HeldArchive>();

    /** Give this to the agent's `QuestionHookServer` as its `receiver`. */
    public readonly receiver: HookReceiver = {
        receive: (launchId, asked, reply) => this.receive(launchId, asked, reply),
        receiveRound: (launchId, questions) => this.notify({type: 'grill-round', launchId, questions}),
        promptSubmitted: (launchId) => this.notify({type: 'prompt-submitted', launchId}),
    };

    /** Give this to the agent's `QuestionHookServer` as its `archiveTool`. */
    public readonly archiveTool: HookArchiveTool = {
        request: (launchId) => this.requestArchive(launchId),
        turnEnded: (launchId) => this.notify({type: 'turn-ended', launchId}),
    };

    constructor(private readonly deps: HookForwarderDeps) {}

    public clientConnected(client: ClientLink): void {
        if (!this.clients.includes(client)) this.clients.push(client);
    }

    /** Release everything the client held: its asks with no decision, its archive calls as failed. */
    public clientGone(client: ClientLink): void {
        const index = this.clients.indexOf(client);
        if (index >= 0) this.clients.splice(index, 1);
        for (const [hookId, held] of [...this.asks]) {
            if (held.client !== client) continue;
            this.asks.delete(hookId);
            held.reply(NO_DECISION);
        }
        for (const [hookId, held] of [...this.archives]) {
            if (held.client === client) this.settleArchive(hookId, held, CLIENT_GONE_OUTCOME);
        }
    }

    /**
     * An answer from the Mac. Only the client an ask or call was sent to may
     * answer it; a reply for anything else (already withdrawn, timed out, or
     * sent elsewhere) is dropped.
     */
    public handle(client: ClientLink, message: HookForwarderMessage): void {
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
            {ask: `${url}/ask/${id}`, stop: `${url}/stop/${id}`, prompt: `${url}/prompt/${id}`},
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
        const client = this.current();
        if (!client) return Promise.resolve(NO_CLIENT_OUTCOME);
        const hookId = this.deps.ids.newId();
        return new Promise((resolve) => {
            const timer = this.deps.timers.setTimeout(() => {
                const held = this.archives.get(hookId);
                if (!held) return;
                this.deps.log.warn(`[agent-hooks] archive call for ${launchId} timed out`);
                this.settleArchive(hookId, held, TIMED_OUT_OUTCOME);
            }, this.deps.archiveTimeoutMs ?? ARCHIVE_REPLY_TIMEOUT_MS);
            this.archives.set(hookId, {client, timer, resolve});
            client.send({type: 'archive-request', hookId, launchId});
        });
    }

    private settleArchive(hookId: string, held: HeldArchive, outcome: ArchiveToolOutcome): void {
        this.archives.delete(hookId);
        this.deps.timers.clearTimeout(held.timer);
        held.resolve(outcome);
    }

    /** A notice the CLI was already answered for: to the client if there is one, else dropped. */
    private notify(message: GrillRoundMessage | PromptSubmittedMessage | TurnEndedMessage): void {
        const client = this.current();
        if (client) client.send(message);
        else this.deps.log.debug(`[agent-hooks] no client; dropped ${message.type} for ${message.launchId}`);
    }

    /** The most recently connected client whose link is still open. */
    private current(): ClientLink | null {
        for (let i = this.clients.length - 1; i >= 0; i--) {
            if (!this.clients[i].closed) return this.clients[i];
        }
        return null;
    }
}
