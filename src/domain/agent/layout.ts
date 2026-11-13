/**
 * Where the agent lives on a VM, and what it runs on (#276).
 *
 * Everything is under the VM user's home, so installing needs no root except
 * for `loginctl enable-linger`. Each agent version gets a folder of its own so
 * an upgrade can unpack beside the running one and switch the `current` link.
 * Paths start with `$HOME` so they expand in the remote shell the provisioner
 * runs, never on the Mac.
 */

/** The root of everything Switchboard puts on the VM. */
export const AGENT_HOME = '$HOME/.switchboard';

/** The Unix socket the agent listens on, mode 0600. */
export const AGENT_SOCKET = `${AGENT_HOME}/agent.sock`;

/** One agent version, unpacked: `agent.js`, `connect.js` and the node-pty build. */
export function agentVersionDir(version: string): string {
    return `${AGENT_HOME}/agent/${version}`;
}

/** A link to the version that runs; the service starts `current/agent.js`. */
export const AGENT_CURRENT = `${AGENT_HOME}/agent/current`;

/** One Node runtime, unpacked. */
export function nodeDir(nodeVersion: string): string {
    return `${AGENT_HOME}/node/${nodeVersion}`;
}

/** The command the Mac runs over ssh; bridges its stdio to the socket. */
export const AGENT_CONNECT_COMMAND = `${AGENT_HOME}/bin/switchboard-agent connect`;

/** The script behind `AGENT_CONNECT_COMMAND`, which also answers `version`. */
export const AGENT_BIN = `${AGENT_HOME}/bin/switchboard-agent`;

/** The host settings, as JSON. */
export const HOST_SETTINGS_FILE = `${AGENT_HOME}/host-settings.json`;

/**
 * The sessions that archived themselves while no Mac was connected (#308), as
 * JSON: `[{sessionId, archivedAt}]`. Mode 0600, written atomically; the Mac
 * reads and clears it on every connect.
 */
export const SELF_ARCHIVED_FILE = `${AGENT_HOME}/self-archived.json`;

/**
 * The sessions the agent started by itself (#438), as JSON:
 * `[{sessionId, cwd, startedAt, errand?}]`. Mode 0600, written atomically;
 * the Mac reads and clears it on connect, as it does SELF_ARCHIVED_FILE.
 */
export const SELF_STARTED_FILE = `${AGENT_HOME}/self-started.json`;

/**
 * The Merge manager's lane state while this VM is the Merging host (#438):
 * landed pull requests and fix errand ownership (`domain/agent/lane-state`).
 * Mode 0600, written atomically; read again after every agent start.
 */
export const LANE_STATE_FILE = `${AGENT_HOME}/lane-state.json`;

/** The systemd user unit's name and file. */
export const AGENT_UNIT = 'switchboard-agent.service';
export const AGENT_UNIT_FILE = `$HOME/.config/systemd/user/${AGENT_UNIT}`;

/**
 * The Node the agent runs on, downloaded on the VM from nodejs.org and checked
 * against these SHA-256 sums before it is unpacked (the packaging decision on
 * #276: the app ships no Node of its own). The sums are of the official
 * `node-v<version>-linux-<arch>.tar.xz` files, copied from
 * https://nodejs.org/dist/v22.22.2/SHASUMS256.txt, and change together with the
 * version: bumping it means copying the two new lines from that version's
 * SHASUMS256.txt.
 */
export const AGENT_NODE = {
    version: '22.22.2',
    sha256: {
        x64: '88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a',
        arm64: 'e9e1930fd321a470e29bb68f30318bf58e3ecb4acb4f1533fb19c58328a091fe',
    },
} as const;

/** The CPU architectures the agent ships a node-pty build for. */
export type AgentArch = keyof typeof AGENT_NODE.sha256;
