/**
 * The Mac's answers about VM hosts (#276), behind the `AgentHosts` façade.
 *
 * Two sources, joined here so the IPC handlers need neither: the installer
 * knows what is on a host before any link exists (installed? which version?),
 * and the agent connection is how a running agent is asked anything else.
 * Questions for a host that cannot be reached answer null rather than throw,
 * which the UI shows as its "couldn't reach the VM" state.
 */
import {parseRemoteProjectPath} from '../../domain/project/remote-target';
import type {HostSettings, ToolCheck} from '../../domain/agent/protocol';
import type {IdGenerator} from '../ports/ids';
import type {Logger} from '../ports/logger';
import type {AgentClient} from './agent-client/agent-client';
import type {AgentConnection} from './agent-client/agent-connection';
import type {AgentHosts, AgentHostsResult, AgentHostStatus} from './agent-hosts';
import type {OpenSessionRequest, OpenSessionResult} from './session-launcher';

/** What the installer answers; the provisioning ticket's service. */
export interface AgentInstaller {
    /** The agent version on the host, or null when there is none (or it cannot be asked). */
    installedVersion(projectPath: string): Promise<string | null>;
    install(projectPath: string, onProgress?: (line: string) => void): Promise<AgentHostsResult>;
}

export interface AgentHostsServiceDeps {
    agents: Pick<AgentClient, 'connection' | 'connectionFor'>;
    installer: AgentInstaller;
    launcher: {open(request: OpenSessionRequest): Promise<OpenSessionResult>};
    /** The setup terminal's script, as the agent types it into the shell. */
    setupCommand: string;
    appVersion: string;
    ids: IdGenerator;
    log: Logger;
}

/** How long a question to a host may wait for its link to come up. */
export const HOST_REACH_TIMEOUT_MS = 15_000;

export class AgentHostsService implements AgentHosts {
    constructor(private readonly deps: AgentHostsServiceDeps) {}

    public async status(projectPath: string): Promise<AgentHostStatus> {
        const installed = await this.deps.installer.installedVersion(projectPath).catch(() => null);
        return {
            installed,
            current: installed === this.deps.appVersion,
            connected: this.deps.agents.connectionFor(projectPath)?.connected ?? false,
        };
    }

    public async install(projectPath: string, onProgress?: (line: string) => void): Promise<AgentHostsResult> {
        const result = await this.deps.installer.install(projectPath, onProgress);
        // A link that gave up on the old agent (or found none) tries the new one.
        if (result.ok) this.deps.agents.connectionFor(projectPath)?.retryNow();
        return result;
    }

    public checkTools(projectPath: string): Promise<{tools: ToolCheck[]; sudo: boolean} | null> {
        return this.ask(projectPath, 'check tools', (connection) => connection.checkTools());
    }

    public hostSettings(projectPath: string): Promise<HostSettings | null> {
        return this.ask(projectPath, 'read host settings', (connection) => connection.getHostSettings());
    }

    public setHostSettings(projectPath: string, settings: Partial<HostSettings>): Promise<HostSettings | null> {
        return this.ask(projectPath, 'save host settings', (connection) => connection.setHostSettings(settings));
    }

    public async openSetupTerminal(
        projectPath: string,
    ): Promise<{ok: true; sessionId: string} | {ok: false; error: string}> {
        const sessionId = this.deps.ids.newId();
        const result = await this.deps.launcher.open({
            sessionId,
            projectPath,
            isNew: true,
            options: {type: 'remote', remoteKind: 'shell', agentCommand: this.deps.setupCommand},
        });
        return result.ok
            ? {ok: true, sessionId}
            : {ok: false, error: result.error ?? 'the setup terminal did not open'};
    }

    /** Ask the host's agent something once its link is up; null when it cannot be reached in time. */
    private async ask<T>(
        projectPath: string,
        what: string,
        question: (connection: AgentConnection) => Promise<T>,
    ): Promise<T | null> {
        const host = parseRemoteProjectPath(projectPath);
        if (!host) return null;
        const connection = this.deps.agents.connection(host);
        try {
            if (connection.state === 'failed') connection.retryNow();
            await withTimeout(connection.whenConnected(), HOST_REACH_TIMEOUT_MS);
            return await question(connection);
        } catch (err) {
            this.deps.log.warn(`[agent-hosts] could not ${what} on ${connection.target}: ${(err as Error).message}`);
            return null;
        }
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err: unknown) => {
                clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            },
        );
    });
}
