/**
 * VM hosts (#276): the project page's Install agent, setup checks and setup
 * terminal, and the host settings in a VM project's settings.
 *
 * Every call goes to the `AgentHosts` façade, which names a host by any
 * project path on it. Install's progress lines are pushed to the window as
 * they come, and a finished install has the project list read again, so the
 * project turns into a VM project there.
 */
import {EVENT, INVOKE} from '../../ipc/channels';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import type {AgentHosts} from '../../application/services/agent-hosts';
import type {HostSettings} from '../../domain/agent/protocol';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

/** The façade, until the composition root builds one; a call before then fails with this. */
function agentHostsOf(app: Container): AgentHosts {
    if (!app.agentHosts) throw new Error('VM hosts aren’t available in this build');
    return app.agentHosts;
}

/** Only an ssh:// project names a host. */
function hostPath(projectPath: unknown): string {
    if (typeof projectPath !== 'string' || !isRemoteProjectPath(projectPath)) {
        throw new Error('Not a remote project');
    }
    return projectPath;
}

/** The host settings a renderer may change, and nothing else it sent. */
function settingsChange(input: unknown): Partial<HostSettings> {
    const change: Partial<HostSettings> = {};
    if (!input || typeof input !== 'object') return change;
    const fields = input as Record<string, unknown>;
    if (typeof fields.instructions === 'string') change.instructions = fields.instructions;
    if (typeof fields.copyConfig === 'boolean') change.copyConfig = fields.copyConfig;
    if (typeof fields.baseFolder === 'string') change.baseFolder = fields.baseFolder;
    return change;
}

export function registerAgentHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.agentStatus, (projectPath: string) => agentHostsOf(app).status(hostPath(projectPath)));

    ipc.handle(INVOKE.agentInstall, async (projectPath: string) => {
        const path = hostPath(projectPath);
        const result = await agentHostsOf(app).install(path, (line) => {
            const window = app.getWindow();
            if (window && !window.isDestroyed()) window.webContents.send(EVENT.agentInstallProgress, path, line);
        });
        if (result.ok) app.renderer.projectsChanged();
        return result;
    });

    ipc.handle(INVOKE.agentCheckTools, (projectPath: string) => agentHostsOf(app).checkTools(hostPath(projectPath)));
    ipc.handle(INVOKE.agentHostSettings, (projectPath: string) =>
        agentHostsOf(app).hostSettings(hostPath(projectPath)),
    );
    ipc.handle(INVOKE.agentSetHostSettings, (projectPath: string, settings: unknown) =>
        agentHostsOf(app).setHostSettings(hostPath(projectPath), settingsChange(settings)),
    );
    ipc.handle(INVOKE.agentOpenSetupTerminal, (projectPath: string) =>
        agentHostsOf(app).openSetupTerminal(hostPath(projectPath)),
    );
}
