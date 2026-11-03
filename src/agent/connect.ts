/**
 * `switchboard-agent connect` and `switchboard-agent version` (#276).
 *
 * The Mac runs `~/.switchboard/bin/switchboard-agent connect` over ssh; this
 * bridges that ssh session's stdio to the agent's Unix socket, byte for byte.
 * It knows nothing of frames or messages, so it never needs to change with
 * the protocol, and it starts fast: it imports `node:net` and the socket path
 * and nothing else (no node-pty, no agent code), which keeps `connect.js`
 * tiny. Check its size in the build output after touching the imports.
 *
 * It exits 0 when either side ends: the Mac closing ssh ends stdin, the agent
 * closing the link ends the socket. When nothing listens on the socket it
 * exits 1 with a line on stderr, which ssh carries back to the Mac.
 */
import net from 'node:net';

import {agentSocketPath} from './paths';
import {AGENT_VERSION} from './version';

/** Exit codes: 0 a clean end, 1 no agent to reach, 2 a wrong command line. */
const EXIT = {ok: 0, unreachable: 1, usage: 2} as const;

/** How long to wait for the agent to close its side after stdin ended. */
const LINGER_MS = 2000;

function exitAfterFlush(code: number): void {
    // stdout may be a pipe whose writes are asynchronous; let it drain first.
    process.stdout.write('', () => process.exit(code));
}

function connect(socketPath: string): void {
    const socket = net.createConnection(socketPath);
    let connected = false;

    socket.once('connect', () => {
        connected = true;
        process.stdin.pipe(socket);
        socket.pipe(process.stdout, {end: false});
    });

    process.stdin.once('end', () => {
        // The Mac went away. Pass the end on, then go once the agent closes
        // its side (it does at once) or the linger runs out.
        socket.end();
        setTimeout(() => exitAfterFlush(EXIT.ok), LINGER_MS).unref();
    });
    socket.once('end', () => exitAfterFlush(EXIT.ok));
    socket.once('close', () => {
        if (connected) exitAfterFlush(EXIT.ok);
    });

    socket.once('error', (err: NodeJS.ErrnoException) => {
        if (connected) return exitAfterFlush(EXIT.ok);
        const why =
            err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
                ? 'no agent is listening there; is the service running? (systemctl --user status switchboard-agent)'
                : err.message;
        process.stderr.write(`switchboard-agent: cannot reach the agent at ${socketPath}: ${why}\n`);
        process.exit(EXIT.unreachable);
    });
}

function run(argv: readonly string[]): void {
    const command = argv[0];
    if (command === 'connect') return connect(agentSocketPath());
    if (command === 'version' || command === '--version') {
        process.stdout.write(`${AGENT_VERSION}\n`);
        return;
    }
    process.stderr.write('usage: switchboard-agent connect | version\n');
    process.exitCode = EXIT.usage;
}

run(process.argv.slice(2));
