/**
 * What the Mac's UI asks about VM hosts (#276), in one place.
 *
 * The IPC handlers call this; the composition root builds it from the agent
 * installer (provisioning) and the agent connections (the live link). A host
 * is named by any project path on it (`ssh://user@host[:port]/dir`).
 */
import type {HostSettings, ToolCheck} from '../../domain/agent/protocol';

export interface AgentHostStatus {
    /** The agent version installed, or null when the host has none. */
    installed: string | null;
    /** Whether that version equals the app's. */
    current: boolean;
    /** Whether a link to the agent is open now. */
    connected: boolean;
}

export interface AgentHostsResult {
    ok: boolean;
    error?: string;
}

export interface AgentHosts {
    status(projectPath: string): Promise<AgentHostStatus>;
    /**
     * Install (or upgrade) the agent on the project's host. Progress lines go to
     * `onProgress`. On success the remote is marked as an agent host and its
     * project becomes a VM project.
     */
    install(projectPath: string, onProgress?: (line: string) => void): Promise<AgentHostsResult>;
    checkTools(projectPath: string): Promise<{tools: ToolCheck[]; sudo: boolean} | null>;
    hostSettings(projectPath: string): Promise<HostSettings | null>;
    setHostSettings(projectPath: string, settings: Partial<HostSettings>): Promise<HostSettings | null>;
    /** Start the setup terminal on the host: a shell session running the setup script. Answers its session id. */
    openSetupTerminal(projectPath: string): Promise<{ok: true; sessionId: string} | {ok: false; error: string}>;
}
