/**
 * Two ends of an agent link joined in memory, for tests that run the Mac side
 * and the agent side in one process (the main seam of #276).
 *
 * Every message goes through the real framing, so a message that would not
 * survive the wire does not survive here either. Delivery is synchronous;
 * `close()` on either end closes both.
 */
import {encodeMessageFrame, encodeOutputFrame, FrameDecoder} from '../../src/domain/agent/framing';
import type {AgentLink, ClientLink} from '../../src/application/ports/agent-link';
import type {AgentMessage, MacMessage, TerminalOutput} from '../../src/domain/agent/protocol';

export interface LinkPair {
    mac: AgentLink;
    agent: ClientLink;
    /** Everything each side sent, in order, for assertions. */
    sentByMac: MacMessage[];
    sentByAgent: (AgentMessage | {output: TerminalOutput})[];
    /** Drop the link as a lost connection would, with no `bye`. */
    drop(reason?: string): void;
}

export function linkPair(): LinkPair {
    const macDecoder = new FrameDecoder();
    const agentDecoder = new FrameDecoder();
    const macListeners: ((m: AgentMessage) => void)[] = [];
    const macOutput: ((o: TerminalOutput) => void)[] = [];
    const agentListeners: ((m: MacMessage) => void)[] = [];
    const closeListeners: ((reason: string) => void)[] = [];
    const sentByMac: MacMessage[] = [];
    const sentByAgent: (AgentMessage | {output: TerminalOutput})[] = [];
    let closed = false;

    const close = (reason: string) => {
        if (closed) return;
        closed = true;
        for (const listener of closeListeners) listener(reason);
    };

    const toMac = (bytes: Buffer) => {
        for (const frame of macDecoder.push(bytes)) {
            if (frame.kind === 'output') macOutput.forEach((l) => l(frame.output));
            else macListeners.forEach((l) => l(frame.message as AgentMessage));
        }
    };

    const mac: AgentLink = {
        send(message) {
            if (closed) return;
            sentByMac.push(message);
            for (const frame of agentDecoder.push(encodeMessageFrame(message)))
                if (frame.kind === 'message') agentListeners.forEach((l) => l(frame.message as MacMessage));
        },
        onMessage: (listener) => void macListeners.push(listener),
        onOutput: (listener) => void macOutput.push(listener),
        onClose: (listener) => void closeListeners.push(listener),
        close: () => close('closed'),
        get closed() {
            return closed;
        },
    };

    const agent: ClientLink = {
        send(message) {
            if (closed) return;
            sentByAgent.push(message);
            toMac(encodeMessageFrame(message));
        },
        sendOutput(output) {
            if (closed) return;
            sentByAgent.push({output});
            toMac(encodeOutputFrame(output));
        },
        onMessage: (listener) => void agentListeners.push(listener),
        onClose: (listener) => void closeListeners.push(listener),
        close: () => close('closed'),
        get closed() {
            return closed;
        },
    };

    return {mac, agent, sentByMac, sentByAgent, drop: (reason = 'dropped') => close(reason)};
}
