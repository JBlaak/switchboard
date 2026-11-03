/**
 * What the project page's VM parts do (#276): Install agent (and Retry, and
 * Update agent), the Setup section's checks and setup terminal, and the host
 * settings in a VM project's settings. The components call these, never
 * `window.api` or the store.
 *
 * A failed call is answered by main as `{ ok: false, error }` in place of
 * what was asked, so each answer is checked for its shape before it is kept.
 */
import {dispatch} from '../../state/app-store';
import {openSetupTerminal} from '../../features/sessions/session-actions';
import type {AgentHostStatus} from '../../../ipc/api';
import type {HostSettings, ToolCheck} from '../../../domain/agent/protocol';

/** Ask whether the host has an agent, and whether it is the app's version. */
export async function loadAgentStatus(projectPath: string): Promise<void> {
    const status: unknown = await window.api.agentStatus(projectPath).catch(() => null);
    if (isStatus(status)) dispatch({type: 'agentStatusLoaded', projectPath, status});
}

/**
 * Install the agent on the project's host, or update it. Progress lines
 * arrive as main pushes them; on success main has the project list read
 * again, and the project is a VM project from here on.
 */
export async function installAgent(projectPath: string): Promise<void> {
    dispatch({type: 'agentInstallStarted', projectPath});
    const result = await window.api.installAgent(projectPath).catch((err: Error) => ({ok: false, error: err.message}));
    dispatch({type: 'agentInstallFinished', projectPath, ok: result.ok === true, error: result.error});
    if (result.ok) {
        void loadAgentStatus(projectPath);
        void refreshAgentTools(projectPath);
    }
}

/** The setup checks, asked again. */
export async function refreshAgentTools(projectPath: string): Promise<void> {
    dispatch({type: 'agentToolsRequested', projectPath});
    const answer: unknown = await window.api.checkAgentTools(projectPath).catch(() => null);
    dispatch({type: 'agentToolsLoaded', projectPath, answer: isTools(answer) ? answer : null});
}

/** Open setup terminal: main starts it on the host, and it opens here like any session. */
export async function openAgentSetupTerminal(projectPath: string): Promise<void> {
    dispatch({type: 'agentSetupTerminalOpening', projectPath});
    const result = await window.api
        .openAgentSetupTerminal(projectPath)
        .catch((err: Error) => ({ok: false as const, error: err.message}));
    if (result.ok) await openSetupTerminal(result.sessionId, projectPath);
    else dispatch({type: 'agentSetupTerminalFailed', projectPath, message: result.error || 'It didn’t start'});
}

/** The host settings, read from the agent. */
export async function loadHostSettings(projectPath: string): Promise<void> {
    dispatch({type: 'agentHostSettingsRequested', projectPath});
    const settings: unknown = await window.api.agentHostSettings(projectPath).catch(() => null);
    dispatch({type: 'agentHostSettingsLoaded', projectPath, settings: isSettings(settings) ? settings : null});
}

/** Store a change to the host settings on the agent; the form shows what it answers. */
export async function saveHostSettings(projectPath: string, change: Partial<HostSettings>): Promise<void> {
    const settings: unknown = await window.api.setAgentHostSettings(projectPath, change).catch(() => null);
    if (isSettings(settings)) dispatch({type: 'agentHostSettingsLoaded', projectPath, settings});
    else
        dispatch({
            type: 'agentHostSettingsSaveFailed',
            projectPath,
            message: 'Couldn’t save: the VM can’t be reached.',
        });
}

// ── Shapes ──

function isStatus(value: unknown): value is AgentHostStatus {
    if (!value || typeof value !== 'object') return false;
    const status = value as Record<string, unknown>;
    return (
        (status.installed === null || typeof status.installed === 'string') &&
        typeof status.current === 'boolean' &&
        typeof status.connected === 'boolean'
    );
}

function isTools(value: unknown): value is {tools: ToolCheck[]; sudo: boolean} {
    if (!value || typeof value !== 'object') return false;
    const answer = value as Record<string, unknown>;
    return Array.isArray(answer.tools) && typeof answer.sudo === 'boolean';
}

function isSettings(value: unknown): value is HostSettings {
    if (!value || typeof value !== 'object') return false;
    const settings = value as Record<string, unknown>;
    return (
        typeof settings.instructions === 'string' &&
        typeof settings.copyConfig === 'boolean' &&
        typeof settings.baseFolder === 'string'
    );
}
