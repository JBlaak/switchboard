/**
 * A VM session's stand-in for a PTY on the Mac (#276).
 *
 * The real PTY is on the VM, owned by the agent. This handle is what the Mac's
 * ActiveSession holds instead, so the lifecycle (OSC parsing, busy/idle,
 * notifications), the terminal and phone handlers, and the prompter all work
 * on a VM session without knowing it is one: writing, resizing and signalling
 * go over the link, output and the exit come back from it.
 *
 * A dropped link is not an exit. The session goes on running on the VM, so
 * the handle stays live (`disposed` false) and simply hears nothing until the
 * link is back and the session has reattached from `lastSeq`.
 */
import type {AgentSessionKind, SignalMessage} from '../../../domain/agent/protocol';
import type {PtyHandle} from '../../ports/terminal-gateway';

/** The signals the protocol carries; others are sent as the nearest of these. */
type AgentSignal = SignalMessage['signal'];
const AGENT_SIGNALS: readonly string[] = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'];

/** Where a handle sends what it is asked to do: the host's connection, through the agent client. */
export interface AgentPtySink {
    input(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    signal(sessionId: string, signal: AgentSignal): void;
}

export interface AgentPtySpec {
    /** The id the session was opened under on the agent; never changes, even if the Mac re-keys the row. */
    sessionId: string;
    /** `user@host:port`, which connection the session lives on. */
    hostKey: string;
    kind: AgentSessionKind;
    cols: number;
    rows: number;
    sink: AgentPtySink;
}

export class AgentPty implements PtyHandle {
    /** There is no local process. */
    public readonly pid = undefined;
    public readonly sessionId: string;
    public readonly hostKey: string;
    public readonly kind: AgentSessionKind;

    /** The last output sequence number shown; what a reattach asks to continue after. */
    public lastSeq = -1;
    /** Set once the agent accepted the `open`; until then there is nothing to reattach. */
    public opened = false;
    /** The last signal asked for, kept until it reaches the agent; a stop made while the link is down. */
    public pendingSignal: AgentSignal | null = null;

    private size: {cols: number; rows: number};
    private isDisposed = false;
    private readonly sink: AgentPtySink;
    private readonly dataListeners: ((data: string) => void)[] = [];
    private readonly exitListeners: ((event: {exitCode: number; signal?: number}) => void)[] = [];

    constructor(spec: AgentPtySpec) {
        this.sessionId = spec.sessionId;
        this.hostKey = spec.hostKey;
        this.kind = spec.kind;
        this.size = {cols: spec.cols, rows: spec.rows};
        this.sink = spec.sink;
    }

    /** True once the session has exited on the agent; a dropped link does not count. */
    public get disposed(): boolean {
        return this.isDisposed;
    }

    /** The size last asked for, which a reattach repeats so the VM's PTY matches the terminal. */
    public get cols(): number {
        return this.size.cols;
    }

    public get rows(): number {
        return this.size.rows;
    }

    public write(data: string): void {
        if (this.isDisposed) return;
        this.sink.input(this.sessionId, data);
    }

    public resize(cols: number, rows: number): void {
        this.size = {cols, rows};
        if (this.isDisposed) return;
        this.sink.resize(this.sessionId, cols, rows);
    }

    public onData(listener: (data: string) => void): void {
        this.dataListeners.push(listener);
    }

    public onExit(listener: (event: {exitCode: number; signal?: number}) => void): void {
        this.exitListeners.push(listener);
    }

    /**
     * Signal the session's whole process tree on the VM: the agent's
     * `signal` does what the local gateway's `signalTree` does. No signal
     * means SIGHUP, as node-pty's own kill.
     */
    public kill(signal?: NodeJS.Signals): void {
        if (this.isDisposed) return;
        const sent: AgentSignal = !signal
            ? 'SIGHUP'
            : AGENT_SIGNALS.includes(signal)
              ? (signal as AgentSignal)
              : 'SIGTERM';
        this.sink.signal(this.sessionId, sent);
    }

    // ── Fed by the agent client ──

    /**
     * One chunk of output. A chunk at or before `lastSeq` was already shown (a
     * replay overlapping what arrived before the drop) and is dropped.
     */
    public feed(seq: number, data: string): void {
        if (this.isDisposed || seq <= this.lastSeq) return;
        this.lastSeq = seq;
        this.emit(data);
    }

    /** Bytes the Mac itself puts on screen (a terminal reset before a replay); not output, so no sequence number. */
    public inject(data: string): void {
        if (this.isDisposed) return;
        this.emit(data);
    }

    /** The session ended on the agent. Fires the exit once. */
    public exit(exitCode: number, signal?: number): void {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.pendingSignal = null;
        for (const listener of this.exitListeners) listener({exitCode, signal});
    }

    private emit(data: string): void {
        for (const listener of this.dataListeners) listener(data);
    }
}

/** Whether a session's PTY is a VM session's stand-in. */
export function isAgentPty(pty: PtyHandle): pty is AgentPty {
    return pty instanceof AgentPty;
}
