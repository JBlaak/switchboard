/**
 * What a VM's controls in Settings → VMs do (#276, #307): Install agent (and
 * Retry, and Update agent), the setup checks and setup terminal, and the
 * host settings. The components call these, never `window.api` or the store.
 *
 * Each takes the VM's key, `user@host:port`, and calls `AgentHosts` with the
 * VM's own address, `ssh://user@host[:port]` with no folder.
 *
 * A failed call is answered by main as `{ ok: false, error }` in place of
 * what was asked, so each answer is checked for its shape before it is kept.
 */
import {dispatch} from '../../state/app-store';
import {openSetupTerminal} from '../../features/sessions/session-actions';
import {hostPathOfKey} from './vm-hosts';
import {loadVmHosts} from './actions';
import type {HostSettings, ToolCheck} from '../../../domain/agent/protocol';

/** The text `updateAgent` asks before it updates. */
export const UPDATE_PROMPT =
    'Update the agent on this VM?\n\nThe agent restarts, which ends every session running on the VM.';

/**
 * Install the agent on the VM, or update it. Progress lines arrive as main
 * pushes them; on success the list is read again for the agent's version.
 */
export async function installAgent(hostKey: string): Promise<void> {
    const path = hostPathOfKey(hostKey);
    if (!path) return;
    dispatch({type: 'agentInstallStarted', hostKey});
    const result = await window.api.installAgent(path).catch((err: Error) => ({ok: false, error: err.message}));
    dispatch({type: 'agentInstallFinished', hostKey, ok: result.ok === true, error: result.error});
    if (result.ok) {
        void loadVmHosts();
        void refreshAgentTools(hostKey);
        void loadHostSettings(hostKey);
    }
}

/**
 * Update the agent on a VM, after saying what it costs: the agent restarts,
 * and every session running on that VM ends with it.
 */
export async function updateAgent(hostKey: string): Promise<void> {
    if (!confirm(UPDATE_PROMPT)) return;
    await installAgent(hostKey);
}

/** The setup checks, asked again. */
export async function refreshAgentTools(hostKey: string): Promise<void> {
    const path = hostPathOfKey(hostKey);
    if (!path) return;
    dispatch({type: 'agentToolsRequested', hostKey});
    const answer: unknown = await window.api.checkAgentTools(path).catch(() => null);
    dispatch({type: 'agentToolsLoaded', hostKey, answer: isTools(answer) ? answer : null});
}

/** Open setup terminal: main starts it on the VM, and it opens here like any session. */
export async function openAgentSetupTerminal(hostKey: string): Promise<void> {
    const path = hostPathOfKey(hostKey);
    if (!path) return;
    dispatch({type: 'agentSetupTerminalOpening', hostKey});
    const result = await window.api
        .openAgentSetupTerminal(path)
        .catch((err: Error) => ({ok: false as const, error: err.message}));
    if (result.ok) await openSetupTerminal(result.sessionId, path);
    else dispatch({type: 'agentSetupTerminalFailed', hostKey, message: result.error || 'It didn’t start'});
}

/** The host settings, read from the agent. */
export async function loadHostSettings(hostKey: string): Promise<void> {
    const path = hostPathOfKey(hostKey);
    if (!path) return;
    dispatch({type: 'agentHostSettingsRequested', hostKey});
    const settings: unknown = await window.api.agentHostSettings(path).catch(() => null);
    dispatch({type: 'agentHostSettingsLoaded', hostKey, settings: isSettings(settings) ? settings : null});
}

/** Store a change to the host settings on the agent; the form shows what it answers. */
export async function saveHostSettings(hostKey: string, change: Partial<HostSettings>): Promise<void> {
    const path = hostPathOfKey(hostKey);
    if (!path) return;
    const settings: unknown = await window.api.setAgentHostSettings(path, change).catch(() => null);
    if (isSettings(settings)) dispatch({type: 'agentHostSettingsLoaded', hostKey, settings});
    else
        dispatch({
            type: 'agentHostSettingsSaveFailed',
            hostKey,
            message: 'Couldn’t save: the VM can’t be reached.',
        });
}

// ── Shapes ──

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
