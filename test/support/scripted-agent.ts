/**
 * A host's agent, scripted, for the Mac's agent client tests (#280).
 *
 * The dialer hands out one in-memory link pair per dial (`linkPair()`), so a
 * test plays the agent end while the code under test plays the Mac end over
 * the real framing. By default the agent welcomes every `hello` and opens
 * every session; a test changes that, drops the current link, or sends
 * whatever an agent would.
 */
import {AGENT_CLOSE, AGENT_PROTOCOL_VERSION} from '../../src/domain/agent/protocol';
import {linkPair} from './agent-link';
import type {LinkPair} from './agent-link';
import type {AgentDialer} from '../../src/application/ports/agent-link';
import type {AgentMessage, HostSettings, MacMessage, OpenSessionMessage} from '../../src/domain/agent/protocol';
import type {RemoteConfig} from '../../src/domain/project/remote-target';

export const HOST_SETTINGS: HostSettings = {
    instructions: 'You are on a VM.',
    copyConfig: true,
    baseFolder: '~/projects',
};

export interface ScriptedAgent {
    dialer: AgentDialer;
    /** Every dial, in order. */
    readonly dials: LinkPair[];
    readonly dialledHosts: RemoteConfig[];
    /** The latest link. */
    current(): LinkPair;
    /** What the Mac sent over every link, `hello`s included. */
    sentByMac(): MacMessage[];
    /** What the Mac sent of one type, over every link. */
    sent<T extends MacMessage['type']>(type: T): Extract<MacMessage, {type: T}>[];
    /** Send as the agent on the latest link. */
    send(message: AgentMessage): void;
    output(sessionId: string, seq: number, data: string): void;
    /** How the next `hello`s are answered. */
    greet: 'welcome' | 'version-mismatch' | 'old-protocol' | 'silent';
    /** How the next `open`s are answered; null leaves them unanswered. */
    answerOpen: ((open: OpenSessionMessage) => AgentMessage | null) | null;
    /** Make the next dial reject with this reason. */
    failNextDial: string | null;
}

export function scriptedAgent(): ScriptedAgent {
    const dials: LinkPair[] = [];
    const dialledHosts: RemoteConfig[] = [];

    const agent: ScriptedAgent = {
        dials,
        dialledHosts,
        greet: 'welcome',
        answerOpen: (open) => ({type: 'opened', requestId: open.requestId, ok: true}),
        failNextDial: null,
        dialer: {
            async dial(host) {
                dialledHosts.push(host);
                if (agent.failNextDial) {
                    const reason = agent.failNextDial;
                    agent.failNextDial = null;
                    throw new Error(reason);
                }
                const pair = linkPair();
                dials.push(pair);
                pair.agent.onMessage((message) => {
                    if (message.type === 'hello') {
                        if (agent.greet === 'welcome')
                            pair.agent.send({
                                type: 'welcome',
                                protocol: AGENT_PROTOCOL_VERSION,
                                agentVersion: message.appVersion,
                                settings: HOST_SETTINGS,
                            });
                        else if (agent.greet === 'old-protocol')
                            pair.agent.send({
                                type: 'welcome',
                                protocol: AGENT_PROTOCOL_VERSION + 1,
                                agentVersion: '0.0.1',
                                settings: HOST_SETTINGS,
                            });
                        else if (agent.greet === 'version-mismatch') {
                            pair.agent.send({type: 'bye', code: AGENT_CLOSE.versionMismatch, reason: 'agent is 1.0.0'});
                            pair.agent.close();
                        }
                        return;
                    }
                    if (message.type === 'open' && agent.answerOpen) {
                        const reply = agent.answerOpen(message);
                        if (reply) pair.agent.send(reply);
                    }
                });
                return pair.mac;
            },
        },
        current: () => dials[dials.length - 1],
        sentByMac: () => dials.flatMap((pair) => pair.sentByMac),
        sent: <T extends MacMessage['type']>(type: T) =>
            agent.sentByMac().filter((m): m is Extract<MacMessage, {type: T}> => m.type === type),
        send: (message) => agent.current().agent.send(message),
        output: (sessionId, seq, data) => agent.current().agent.sendOutput({sessionId, seq, data}),
    };
    return agent;
}

/** Let the dial's promise and whatever it set off run. */
export function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
