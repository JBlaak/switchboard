/**
 * The link between the Mac and a VM's agent, as a dependency (#276).
 *
 * Both ends see the same shape with the directions swapped: the Mac sends
 * MacMessages and receives AgentMessages and output; the agent the other way
 * round. The real links are ssh's stdio on the Mac and a Unix socket
 * connection on the agent, both cut into frames by `domain/agent/framing`.
 * Tests join the two ends in memory.
 */
import type {AgentMessage, MacMessage, TerminalOutput} from '../../domain/agent/protocol';
import type {RemoteConfig} from '../../domain/project/remote-target';

/** One end of a link, sending `Out` and receiving `In`. */
export interface Link<In, Out> {
    send(message: Out): void;
    onMessage(listener: (message: In) => void): void;
    /** Called once, when the link is gone, for whatever reason. */
    onClose(listener: (reason: string) => void): void;
    close(): void;
    readonly closed: boolean;
}

/** The Mac's end. Output arrives on its own listener; the Mac never sends any. */
export interface AgentLink extends Link<AgentMessage, MacMessage> {
    onOutput(listener: (output: TerminalOutput) => void): void;
}

/** The agent's end, one per connected client. */
export interface ClientLink extends Link<MacMessage, AgentMessage> {
    sendOutput(output: TerminalOutput): void;
}

/** Opens a link to a host's agent: on the Mac, `ssh … switchboard-agent connect`. */
export interface AgentDialer {
    /**
     * Resolves once the byte stream is open, before `hello`. Rejects with ssh's
     * own reason when it could not be opened at all (auth, unreachable host).
     */
    dial(host: RemoteConfig): Promise<AgentLink>;
}
