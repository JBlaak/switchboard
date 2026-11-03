/**
 * When a VM's agent is upgraded on its own (#276).
 *
 * Upgrading restarts the agent, and every session running on the VM ends with
 * it. An app update makes every agent it meets older than itself, so upgrading
 * on sight would end the user's work on every VM after every update. The rule:
 *
 * - An agent on another **protocol** cannot be talked to at all: it is
 *   upgraded at once (nothing else can be done with it).
 * - An agent on the same protocol but another **version** is upgraded only
 *   while it has no live session. Otherwise it keeps serving, and the project
 *   page's Update agent does it when the user chooses.
 *
 * One upgrade per host at a time.
 */
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {AgentSessionInfo} from '../../domain/agent/protocol';
import type {Logger} from '../ports/logger';
import type {AgentHostsResult} from './agent-hosts';

/** What the rule needs of a connection that just said `welcome`. */
export interface WelcomedAgent {
    readonly host: RemoteConfig;
    readonly target: string;
    readonly agentVersion: string | null;
    listSessions(): Promise<AgentSessionInfo[]>;
}

export interface AgentUpgradesDeps {
    appVersion: string;
    /** A project path on `host` whose remote is an agent host; null when there is none. */
    agentProjectOn(host: RemoteConfig): string | null;
    install(projectPath: string): Promise<AgentHostsResult>;
    /** Dial the host again, after an upgrade. */
    redial(host: RemoteConfig): void;
    log: Logger;
}

export class AgentUpgrades {
    private readonly upgrading = new Set<string>();

    constructor(private readonly deps: AgentUpgradesDeps) {}

    /** The agent refused the protocol: upgrade, whatever runs there. */
    public protocolMismatch(host: RemoteConfig, reason: string): Promise<void> {
        return this.upgrade(host, reason);
    }

    /** A link came up: upgrade an older agent only while nothing runs on it. */
    public async connected(agent: WelcomedAgent): Promise<void> {
        const {appVersion, log} = this.deps;
        const running = agent.agentVersion;
        if (!running || running === appVersion) return;
        let sessions: AgentSessionInfo[];
        try {
            sessions = await agent.listSessions();
        } catch (err) {
            log.warn(`[agent] could not list sessions on ${agent.target}: ${(err as Error).message}`);
            return;
        }
        const live = sessions.filter((session) => session.alive).length;
        if (live > 0) {
            log.info(
                `[agent] ${agent.target} runs ${running}; ${live} live session(s), not upgrading to ${appVersion}`,
            );
            return;
        }
        await this.upgrade(agent.host, `agent ${running}, app ${appVersion}`);
    }

    private async upgrade(host: RemoteConfig, reason: string): Promise<void> {
        const {log} = this.deps;
        const key = `${host.user}@${host.host}:${host.port}`;
        const projectPath = this.deps.agentProjectOn(host);
        if (!projectPath || this.upgrading.has(key)) return;
        this.upgrading.add(key);
        log.info(`[agent] upgrading ${key}: ${reason}`);
        try {
            const result = await this.deps.install(projectPath);
            if (result.ok) this.deps.redial(host);
            else log.warn(`[agent] upgrade on ${key} failed: ${result.error}`);
        } finally {
            this.upgrading.delete(key);
        }
    }
}
