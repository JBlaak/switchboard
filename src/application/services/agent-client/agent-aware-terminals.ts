/**
 * The terminal gateway, made to understand VM sessions' stand-in PTYs (#276).
 *
 * The lifecycle stops a session with `signalTree` and heals stuck rows with
 * `isAlive`, both answered from a local pid. A VM session has none: its
 * process tree is on the VM, and only the agent can signal it or say it is
 * gone. So a stand-in answers for itself (signalling goes over the link as the
 * agent's `signal`, which reaches the whole tree there) and everything else is
 * the wrapped gateway's, unchanged.
 *
 * A stand-in is alive until the agent reports its exit. A dropped link does
 * not make it dead: the session is still running on the VM.
 */
import type {PtyHandle, SpawnSpec, TerminalGateway} from '../../ports/terminal-gateway';
import {isAgentPty} from './agent-pty';

export class AgentAwareTerminals<T extends TerminalGateway = TerminalGateway> implements TerminalGateway {
    /** @param inner the local gateway (node-pty), which every non-stand-in goes to */
    constructor(public readonly inner: T) {}

    public get baseEnv(): Record<string, string> {
        return this.inner.baseEnv;
    }

    public spawn(spec: SpawnSpec): PtyHandle {
        return this.inner.spawn(spec);
    }

    public signalTree(handle: PtyHandle, signal: NodeJS.Signals): boolean {
        if (!isAgentPty(handle)) return this.inner.signalTree(handle, signal);
        if (handle.disposed) return false;
        handle.kill(signal);
        return true;
    }

    public isAlive(handle: PtyHandle): boolean {
        if (!isAgentPty(handle)) return this.inner.isAlive(handle);
        return !handle.disposed;
    }
}
