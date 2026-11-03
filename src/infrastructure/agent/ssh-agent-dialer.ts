/**
 * The Mac's agent link over ssh (#276): `ssh -T … switchboard-agent connect`,
 * with frames on its stdin and stdout.
 *
 * One process per host link. Its stderr is kept (the tail of it) because it is
 * where ssh says why a link failed or died, and that reason is what the
 * connection card shows and what decides whether redialling is worth it.
 */
import {spawn as spawnProcess} from 'node:child_process';
import type {ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio} from 'node:child_process';
import {encodeMessageFrame, FrameDecoder} from '../../domain/agent/framing';
import {buildAgentSshSpawn, SentinelGate} from '../../domain/agent/ssh-connect';
import type {AgentDialer, AgentLink} from '../../application/ports/agent-link';
import type {AgentMessage, MacMessage, TerminalOutput} from '../../domain/agent/protocol';
import type {Logger} from '../../application/ports/logger';
import type {RemoteConfig} from '../../domain/project/remote-target';

/** How much of ssh's stderr is kept for the failure reason. */
const STDERR_KEEP_CHARS = 2000;

/** `child_process.spawn` with piped stdio, injectable for tests. */
export type SpawnPiped = (
    file: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface SshAgentDialerDeps {
    /** The user's login shell, or null to spawn ssh directly. Read on every dial, so a changed profile applies. */
    shell(): string | null;
    /** The environment ssh starts with; the login shell then layers the user's profile on top. */
    env: Record<string, string>;
    /** Where the process starts; ssh never uses it. */
    cwd: string;
    log: Logger;
    spawn?: SpawnPiped;
}

export class SshAgentDialer implements AgentDialer {
    private readonly spawn: SpawnPiped;

    constructor(private readonly deps: SshAgentDialerDeps) {
        this.spawn = deps.spawn ?? ((file, args, options) => spawnProcess(file, [...args], options));
    }

    /**
     * Resolves once ssh is running, before anything has crossed the link: ssh
     * gives no signal that it has authenticated, so a link that fails to come
     * up shows as one that closes before the agent's `welcome`, with ssh's
     * stderr as the reason. Rejects only when ssh could not be started.
     */
    public dial(host: RemoteConfig): Promise<AgentLink> {
        const plan = buildAgentSshSpawn(host, this.deps.shell());
        this.deps.log.info(`[agent] dialling ${host.user}@${host.host}:${host.port} via ${plan.file}`);
        const child = this.spawn(plan.file, plan.args, {
            cwd: this.deps.cwd,
            env: this.deps.env,
            stdio: 'pipe',
        } as SpawnOptionsWithoutStdio);

        return new Promise((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            child.once('error', onError);
            child.once('spawn', () => {
                child.off('error', onError);
                resolve(new SshAgentLink(child, plan.sentinel, this.deps.log));
            });
        });
    }
}

/** One running ssh, as an AgentLink. */
class SshAgentLink implements AgentLink {
    private readonly decoder = new FrameDecoder();
    private readonly gate: SentinelGate;
    private readonly messageListeners: ((message: AgentMessage) => void)[] = [];
    private readonly outputListeners: ((output: TerminalOutput) => void)[] = [];
    private readonly closeListeners: ((reason: string) => void)[] = [];
    private stderr = '';
    private isClosed = false;
    /** Set when we closed it ourselves, so the reason says so rather than ssh's exit. */
    private closedByUs: string | null = null;

    constructor(
        private readonly child: ChildProcessWithoutNullStreams,
        sentinel: boolean,
        private readonly log: Logger,
    ) {
        this.gate = new SentinelGate(sentinel);
        child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
        child.stderr.on('data', (chunk: Buffer) => {
            this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_KEEP_CHARS);
        });
        // A write to a dead ssh fails here rather than throwing at the caller;
        // the exit that follows closes the link.
        child.stdin.on('error', () => {});
        child.on('error', (err) => this.finish(`ssh failed: ${err.message}`));
        child.on('close', (code, signal) => this.finish(this.exitReason(code, signal)));
    }

    public get closed(): boolean {
        return this.isClosed;
    }

    public send(message: MacMessage): void {
        if (this.isClosed) return;
        this.child.stdin.write(encodeMessageFrame(message));
    }

    public onMessage(listener: (message: AgentMessage) => void): void {
        this.messageListeners.push(listener);
    }

    public onOutput(listener: (output: TerminalOutput) => void): void {
        this.outputListeners.push(listener);
    }

    public onClose(listener: (reason: string) => void): void {
        this.closeListeners.push(listener);
    }

    public close(): void {
        if (this.isClosed) return;
        this.closedByUs ??= 'closed';
        this.child.stdin.end();
        this.child.kill('SIGTERM');
    }

    private receive(chunk: Buffer): void {
        if (this.isClosed) return;
        const bytes = this.gate.push(chunk);
        if (!bytes.length) return;
        let frames;
        try {
            frames = this.decoder.push(bytes);
        } catch (err) {
            this.log.warn(`[agent] unreadable frame, closing the link: ${(err as Error).message}`);
            this.closedByUs = `protocol error: ${(err as Error).message}`;
            this.close();
            return;
        }
        for (const frame of frames) {
            if (frame.kind === 'output') this.outputListeners.forEach((l) => l(frame.output));
            else this.messageListeners.forEach((l) => l(frame.message as AgentMessage));
        }
    }

    /** ssh's last words when it has any, else what its exit says. */
    private exitReason(code: number | null, signal: NodeJS.Signals | null): string {
        if (this.closedByUs) return this.closedByUs;
        const said = this.stderr
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        if (said.length) return said.slice(-3).join(' ');
        if (signal) return `ssh was terminated (signal ${signal})`;
        return `ssh exited with code ${code ?? 'unknown'}`;
    }

    private finish(reason: string): void {
        if (this.isClosed) return;
        this.isClosed = true;
        for (const listener of this.closeListeners) listener(reason);
    }
}
