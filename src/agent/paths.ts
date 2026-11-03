/**
 * Where the agent's socket is on this machine (#276).
 *
 * `layout.ts` writes paths with `$HOME` so they expand in the remote shell the
 * Mac's provisioner runs. The agent and the bridge run on the VM itself, with
 * no shell in between, so they expand it here.
 *
 * Kept to `node:os` alone: the `connect` bridge imports this, and it must stay
 * small enough to start in a blink on every connect.
 */
import os from 'node:os';

import {AGENT_SOCKET} from '../domain/agent/layout';

/**
 * Overrides the socket path, for tests and for running a second agent by hand
 * beside the installed one. Never set by the service unit.
 */
export const SOCKET_ENV = 'SWITCHBOARD_AGENT_SOCKET';

/** `path` with a leading `$HOME` (or `~`) replaced by the home folder. */
export function expandHome(path: string, home: string = os.homedir()): string {
    return path.replace(/^(\$HOME|~)(?=\/|$)/, home);
}

/** The socket this process listens on or connects to. */
export function agentSocketPath(env: NodeJS.ProcessEnv = process.env): string {
    return env[SOCKET_ENV] || expandHome(AGENT_SOCKET);
}
