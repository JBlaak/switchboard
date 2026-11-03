/**
 * The headless agent, `switchboard-agent` (#276): what the systemd user
 * service runs on a VM, as `node agent/current/agent.js`.
 *
 * It is a copy of the part of Switchboard's main process that runs sessions,
 * with no Electron: the router (`AgentHost`) behind a Unix socket, and the
 * parts it hands messages to. The Mac reaches it through
 * `switchboard-agent connect` over ssh (`connect.ts`), so this process never
 * opens a network port.
 *
 * `startAgent` is the whole process minus the things only a real run has
 * (signals, `process.exit`, the real parts), so tests start it against a temp
 * socket with fake parts.
 */
import type {Logger} from '../application/ports/logger';
import {AgentHost, type AgentParts} from '../application/services/agent-host/agent-host';
import {AGENT_CLOSE} from '../domain/agent/protocol';
import {listenOnUnixSocket} from '../infrastructure/agent/unix-socket-server';
import {stderrLogger} from './log';
import {createParts} from './parts';
import {agentSocketPath} from './paths';
import {AGENT_VERSION} from './version';

export interface StartAgentOptions {
    parts: AgentParts;
    /** Expanded, no `$HOME`. */
    socketPath: string;
    agentVersion: string;
    log: Logger;
}

export interface RunningAgent {
    /**
     * Say `bye shutting-down` to every client, stop listening and remove the
     * socket. Sessions are left running: stopping them is the caller's choice
     * (the service's SIGTERM does, a test may not).
     */
    stop(): Promise<void>;
}

/** Listen on `socketPath` and route every client through the parts. */
export async function startAgent(options: StartAgentOptions): Promise<RunningAgent> {
    const {parts, socketPath, agentVersion, log} = options;
    const host = new AgentHost({parts, agentVersion, log});
    const server = await listenOnUnixSocket({socketPath, log, onClient: (client) => host.accept(client)});
    let stopping: Promise<void> | null = null;
    return {
        stop: () =>
            (stopping ??= (async () => {
                host.closeAll(AGENT_CLOSE.shuttingDown, 'the agent is stopping');
                await server.close();
            })()),
    };
}

/** The service's entry: start, then stop cleanly on SIGTERM (systemd) or SIGINT (a terminal). */
export async function main(): Promise<void> {
    const log = stderrLogger();
    process.on('uncaughtException', (err) => {
        // Unknown state; let systemd's Restart= bring up a fresh process.
        log.error('agent: uncaught exception', err);
        process.exit(1);
    });
    process.on('unhandledRejection', (err) => log.error('agent: unhandled rejection', err));

    log.info(`agent: switchboard-agent ${AGENT_VERSION} starting (node ${process.version})`);
    const parts = await createParts({agentVersion: AGENT_VERSION, log});
    const agent = await startAgent({parts, socketPath: agentSocketPath(), agentVersion: AGENT_VERSION, log});

    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`agent: ${signal}, shutting down`);
        parts.sessions.terminateAll();
        agent.stop().then(
            () => process.exit(0),
            (err: unknown) => {
                log.error('agent: stop failed', err);
                process.exit(1);
            },
        );
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

// Run only as the bundle's entry, not when a test imports startAgent.
if (require.main === module) {
    main().catch((err: unknown) => {
        process.stderr.write(
            `<3>agent: failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
        process.exit(1);
    });
}
