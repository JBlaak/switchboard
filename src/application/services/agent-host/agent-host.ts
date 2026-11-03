/**
 * The agent's router: the handshake, and handing each message to its part (#276).
 *
 * Every client link (one per `switchboard-agent connect` the Mac runs over
 * ssh) comes through `accept`. The first message must be `hello` at this
 * agent's own protocol and app version; anything else ends the link with a
 * `bye` saying why. After the handshake the router does no work of its own:
 * each message type belongs to exactly one part (sessions, hooks, host
 * config, as `handlers.ts` lists them), and the parts are told when a client
 * arrives and when it goes so they know whom they may talk to.
 *
 * The router checks every message's shape (`domain/agent/validate`) before a
 * part sees it, so a part may trust the types it is handed. The ClientLink
 * type already promises a MacMessage, but on the wire that promise is only as
 * good as the peer, so the router treats what arrives as unknown.
 */
import type {ClientLink} from '../../ports/agent-link';
import type {Logger} from '../../ports/logger';
import {
    AGENT_CLOSE,
    AGENT_PROTOCOL_VERSION,
    type AgentCloseCode,
    type HelloMessage,
    type MacMessage,
} from '../../../domain/agent/protocol';
import {parseMacMessage} from '../../../domain/agent/validate';
import type {
    HookForwarderMessage,
    HookForwarderPart,
    HostConfigMessage,
    HostConfigPart,
    SessionHostMessage,
    SessionHostPart,
} from './handlers';

/** The three parts every message after the handshake is handed to. */
export interface AgentParts {
    sessions: SessionHostPart;
    hooks: HookForwarderPart;
    config: HostConfigPart;
}

export interface AgentHostDeps {
    parts: AgentParts;
    /** This agent's own version, which a client's `hello.appVersion` must equal. */
    agentVersion: string;
    log: Logger;
}

/** Which part owns each message type. `hello` and `bye` are the router's own. */
type Owner = 'sessions' | 'hooks' | 'config';

/**
 * Keyed by every routed type, so a message added to `handlers.ts` without a
 * route here is a compile error rather than a protocol error at runtime.
 */
const OWNER: Record<Exclude<MacMessage['type'], 'hello' | 'bye'>, Owner> = {
    open: 'sessions',
    attach: 'sessions',
    input: 'sessions',
    resize: 'sessions',
    signal: 'sessions',
    'list-sessions': 'sessions',
    'ask-reply': 'hooks',
    'archive-reply': 'hooks',
    'get-host-settings': 'config',
    'set-host-settings': 'config',
    'check-tools': 'config',
    'copy-config': 'config',
};

/** Where one client's link is: waiting for `hello`, handed to the parts, or ended. */
type ClientState = 'awaiting-hello' | 'connected' | 'closed';

export class AgentHost {
    private readonly clients = new Set<ClientLink>();

    constructor(private readonly deps: AgentHostDeps) {}

    /** Take a new client link; the router owns it from here until it closes. */
    public accept(client: ClientLink): void {
        let state: ClientState = 'awaiting-hello';
        this.clients.add(client);

        client.onClose((reason) => {
            const wasConnected = state === 'connected';
            state = 'closed';
            this.clients.delete(client);
            this.deps.log.info(`agent: client gone (${reason})`);
            // Parts only ever heard of a client that finished its handshake, so
            // only that client is reported gone, and `onClose` fires once per
            // link, so it is reported once.
            if (wasConnected) this.eachPart((part) => part.clientGone(client), 'clientGone');
        });

        client.onMessage((raw: unknown) => {
            if (state === 'closed' || client.closed) return;
            const parsed = parseMacMessage(raw);
            if (!parsed.ok) return this.refuse(client, AGENT_CLOSE.protocolError, parsed.reason);
            const message = parsed.message;

            if (state === 'awaiting-hello') {
                if (message.type !== 'hello') {
                    return this.refuse(client, AGENT_CLOSE.protocolError, `expected hello, got ${message.type}`);
                }
                if (!this.handshake(client, message)) return;
                state = 'connected';
                this.eachPart((part) => part.clientConnected(client), 'clientConnected');
                return;
            }

            this.route(client, message);
        });
    }

    /**
     * Say goodbye to every client and close it, for an orderly shutdown. The
     * parts hear `clientGone` for each through the links' own close.
     */
    public closeAll(code: AgentCloseCode = AGENT_CLOSE.shuttingDown, reason?: string): void {
        for (const client of [...this.clients]) this.refuse(client, code, reason);
    }

    /** How many clients are linked now, handshake done or not. */
    public get clientCount(): number {
        return this.clients.size;
    }

    /** Answer `hello`: `welcome` when the versions match, else `bye` and close. */
    private handshake(client: ClientLink, hello: HelloMessage): boolean {
        const {agentVersion} = this.deps;
        if (hello.protocol !== AGENT_PROTOCOL_VERSION || hello.appVersion !== agentVersion) {
            this.refuse(
                client,
                AGENT_CLOSE.versionMismatch,
                `agent ${agentVersion} speaks protocol ${AGENT_PROTOCOL_VERSION}; ` +
                    `client is ${hello.appVersion} on protocol ${hello.protocol}`,
            );
            return false;
        }
        client.send({
            type: 'welcome',
            protocol: AGENT_PROTOCOL_VERSION,
            agentVersion,
            settings: this.deps.parts.config.current(),
        });
        this.deps.log.info(`agent: client connected (app ${hello.appVersion})`);
        return true;
    }

    private route(client: ClientLink, message: MacMessage): void {
        if (message.type === 'bye') {
            // The client is leaving on purpose; nothing to answer.
            this.deps.log.info(
                `agent: client said bye (${message.code}${message.reason ? `: ${message.reason}` : ''})`,
            );
            client.close();
            return;
        }
        if (message.type === 'hello') {
            this.refuse(client, AGENT_CLOSE.protocolError, 'hello after the handshake');
            return;
        }
        const {sessions, hooks, config} = this.deps.parts;
        // A part that throws has a bug, not a bad client: log it and keep the
        // link, so one broken request does not cost the Mac every session.
        try {
            switch (OWNER[message.type]) {
                case 'sessions':
                    return sessions.handle(client, message as SessionHostMessage);
                case 'hooks':
                    return hooks.handle(client, message as HookForwarderMessage);
                case 'config':
                    return config.handle(client, message as HostConfigMessage);
            }
        } catch (err) {
            this.deps.log.error(`agent: ${message.type} failed`, err);
        }
    }

    /** Send `bye` and close; the link's close listener does the rest. */
    private refuse(client: ClientLink, code: AgentCloseCode, reason?: string): void {
        if (client.closed) return;
        if (code !== AGENT_CLOSE.shuttingDown) this.deps.log.warn(`agent: closing client, ${code}: ${reason ?? ''}`);
        client.send(reason === undefined ? {type: 'bye', code} : {type: 'bye', code, reason});
        client.close();
    }

    /** Tell every part something, so one part's failure does not keep it from the others. */
    private eachPart(call: (part: SessionHostPart | HookForwarderPart | HostConfigPart) => void, what: string): void {
        const {sessions, hooks, config} = this.deps.parts;
        for (const part of [sessions, hooks, config]) {
            try {
                call(part);
            } catch (err) {
                this.deps.log.error(`agent: ${what} failed`, err);
            }
        }
    }
}
