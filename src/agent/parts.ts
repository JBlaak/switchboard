/**
 * ─── INTEGRATION POINT ───────────────────────────────────────────────────────
 *
 * Builds the agent's three parts from real Node adapters (#276, stage 1).
 *
 * The parts (`SessionHostPart`, `HookForwarderPart`, `HostConfigPart` in
 * `application/services/agent-host/handlers.ts`) are built by other tickets in
 * parallel, so this is the one place the headless entry (`main.ts`) reaches
 * for them, and for now it throws. The integrator replaces the body with the
 * wiring: node-pty behind the session part's terminal, the fs and the login
 * shell, the hook forwarder's 127.0.0.1 server (awaited here, so the parts
 * are ready before the first client), and the host config part reading
 * `HOST_SETTINGS_FILE`. Nothing else in `src/agent` needs to change.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type {Logger} from '../application/ports/logger';
import type {AgentParts} from '../application/services/agent-host/agent-host';

/** What the entry hands the wiring. */
export interface PartsContext {
    agentVersion: string;
    log: Logger;
}

/** The agent's parts, ready to serve; may await their own servers first. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/require-await
export async function createParts(context: PartsContext): Promise<AgentParts> {
    throw new Error('not wired yet: createParts() in src/agent/parts.ts awaits the integration of #276 stage 1');
}
