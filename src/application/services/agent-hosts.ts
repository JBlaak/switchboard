/**
 * What the Mac's UI asks about VM hosts (#276), in one place.
 *
 * The IPC handlers call this; the composition root builds it from the agent
 * installer (provisioning) and the agent connections (the live link). A host
 * is named by any `ssh://` path on it: the VM's own (`vmHostPath`, no folder,
 * as Settings → VMs names it) or any project path there
 * (`ssh://user@host[:port]/dir`, as a project page does).
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
     * Install (or upgrade) the agent on the host. Progress lines go to
     * `onProgress`. On success the host's VM registration is marked with the
     * version (registering it if it wasn't), and its remote projects become VM
     * projects.
     */
    install(projectPath: string, onProgress?: (line: string) => void): Promise<AgentHostsResult>;
    checkTools(projectPath: string): Promise<{tools: ToolCheck[]; sudo: boolean} | null>;
    hostSettings(projectPath: string): Promise<HostSettings | null>;
    setHostSettings(projectPath: string, settings: Partial<HostSettings>): Promise<HostSettings | null>;
    /**
     * Start the setup terminal on the host: a shell session running the setup
     * script, in the folder the path names. Given the VM's own path that is its
     * home, which is then listed as the VM's home project (the session's row
     * lives there). Answers its session id.
     */
    openSetupTerminal(projectPath: string): Promise<{ok: true; sessionId: string} | {ok: false; error: string}>;
}
