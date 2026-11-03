/**
 * Settings → VMs (#276, after stage 5): registering VMs on their own, as
 * phones are paired, rather than by adding a remote project first.
 *
 * A VM is a host (`user@host[:port]`) with no folder. Installing, updating,
 * the setup checks and terminal and the host's settings (instructions, config
 * copy, base folder) all belong to the VM, not to one of its projects. Its
 * projects come from using it: hand-offs (into its base folder), and folders
 * added on it. A VM's address for the per-host calls of `AgentHosts` is its
 * host path, `vmHostPath(key)`: `ssh://user@host[:port]` with no folder.
 *
 * The IPC handlers call this; the composition root builds it.
 */

export interface VmHostView {
    /** `user@host:port`, which names the VM from here on. */
    key: string;
    user: string;
    host: string;
    port: number;
    /** Its name, or `user@host` (with `:port` when not 22). */
    label: string;
    /** The installed agent's version; null until an install finished. */
    agent: string | null;
    /** Whether that version is the app's. */
    current: boolean;
    /** Whether a link to its agent is open now. */
    connected: boolean;
    /** The project paths on it (copies, worktrees, added folders). */
    projects: string[];
}

export interface VmRegistry {
    list(): VmHostView[];
    /** Register a VM; refused for a bad or already registered address. Installs nothing yet. */
    add(input: {
        user: string;
        host: string;
        port?: number;
        name?: string;
    }): {ok: true; key: string} | {ok: false; error: string};
    rename(key: string, name: string): boolean;
    /**
     * Forget a VM and its projects here. The agent and every session on the
     * VM keep running; registering it again picks them up.
     */
    remove(key: string): {ok: true} | {ok: false; error: string};
}
