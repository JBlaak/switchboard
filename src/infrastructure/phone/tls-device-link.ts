/**
 * The listener the phones connect to (Phone access, #194): a Node `tls`
 * server, TLS 1.3 only, carrying the `ws` package's WebSocket server.
 *
 * Trust is settled at the TLS layer. Every client must present a certificate;
 * once its handshake completes, the fingerprint (lowercase hex SHA-256 of the
 * DER) goes to `handlers.authorize`, and a `null` grant destroys the socket
 * before a single HTTP byte is read, so a refused client never gets as far as
 * a WebSocket upgrade, let alone a protocol message. `rejectUnauthorized` is
 * off because every certificate here is self-signed: pinning, not a CA, is
 * what decides.
 *
 * Bound to the LAN and VPN interfaces (see `listenAddresses`), one TLS server
 * per address, all on the same port (kept when the addresses change, see
 * `updateAddresses`, and across launches by the caller passing it back), so a phone on the same VPN as the Mac
 * (WireGuard, Tailscale) reaches it too. Never loopback-only (a phone couldn't
 * reach it), and never the wildcard address, which would also listen on
 * AirDrop, Internet Sharing and virtual machine interfaces. A VPN peer gets no
 * further than a LAN one: the certificate pinning below decides.
 *
 * Text frames are one JSON ClientMessage each; anything that doesn't parse,
 * and any binary frame from the phone, closes with CLOSE.protocolError.
 * Terminal output goes out as binary frames in the layout protocol.ts
 * describes. The codec is injected so this adapter stays about sockets.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import tls from 'node:tls';
import type {AddressInfo, Socket} from 'node:net';
import {WebSocket, WebSocketServer} from 'ws';

import {CLOSE} from '../../domain/phone/protocol';
import type {ClientMessage, ServerMessage} from '../../domain/phone/protocol';
import type {Logger} from '../../application/ports/logger';
import type {
    AddressChange,
    ConnectionGrant,
    DeviceConnection,
    DeviceLink,
    DeviceLinkHandlers,
    ServerIdentity,
} from '../../application/ports/phone-access';

/** Far more than any control message; the phone never sends bulk data. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** A client that hasn't finished its TLS handshake by then is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** How long `stop` waits for closing handshakes before cutting sockets. */
const STOP_GRACE_MS = 1_000;

/** A peer that misses this many pings in a row is dropped. */
const MISSED_PINGS_ALLOWED = 2;

/**
 * Interface names no phone reaches the Mac on: gif/stf (IPv6 tunnelling),
 * awdl/llw (AirDrop's peer-to-peer Wi-Fi), anpi, and bridge/vmenet (Internet
 * Sharing and virtual machines).
 */
const UNREACHABLE_INTERFACE = /^(gif|stf|awdl|llw|anpi|bridge|vmenet)/;

/**
 * Tunnel and VPN interfaces: macOS's utun (WireGuard, Tailscale, iCloud Private
 * Relay), ipsec and ppp (system VPNs), tun/tap/wg (third-party VPNs). A phone on
 * the same VPN reaches their routable addresses; their link-local ones are the
 * system's own (iCloud Private Relay's utun0–3 carry nothing else).
 */
const TUNNEL_INTERFACE = /^(utun|ipsec|ppp|tun|tap|wg)/;

/**
 * The addresses to listen on: every non-internal IPv4 and IPv6 address of the
 * LAN and VPN interfaces, leaving out UNREACHABLE_INTERFACE and a tunnel's
 * link-local addresses. IPv6 link-local addresses carry their interface as a
 * scope (`fe80::1%en0`), which is what binding to one needs.
 */
export function listenAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
    const addresses: string[] = [];
    for (const [name, infos] of Object.entries(interfaces)) {
        if (!infos || UNREACHABLE_INTERFACE.test(name)) continue;
        const tunnel = TUNNEL_INTERFACE.test(name);
        for (const info of infos) {
            if (info.internal) continue;
            if (info.family === 'IPv4') {
                addresses.push(info.address);
            } else if (info.address.toLowerCase().startsWith('fe80:')) {
                if (!tunnel) addresses.push(`${info.address.split('%')[0]}%${name}`);
            } else {
                addresses.push(info.address);
            }
        }
    }
    return addresses;
}

export interface TlsDeviceLinkDeps {
    /** The domain codec's text-frame parser: null for anything that isn't a ClientMessage. */
    parse(text: string): ClientMessage | null;
    /** The domain codec's binary terminal frame (see protocol.ts). */
    encodeTerminalFrame(sessionId: string, data: string): Uint8Array;
    log: Logger;
    /** Where to listen; `listenAddresses` by default. Tests pass loopback. */
    addresses?: () => string[];
    /** The ping interval; 20 s by default. */
    keepaliveMs?: number;
}

interface Peer {
    fingerprint: string;
    grant: Exclude<ConnectionGrant, null>;
    /** The address of the server the phone came in on. */
    address: string;
}

interface Live {
    ws: WebSocket;
    connection: DeviceConnection;
    missedPings: number;
    /** The address of the server it came in on: it closes when that address goes away. */
    address: string;
}

/** One address's TLS server and the authorised sockets that arrived on it. */
interface Listener {
    server: tls.Server;
    sockets: Set<tls.TLSSocket>;
}

/** What one round of binding left behind. */
interface Binding {
    port: number;
    /** Why the addresses that didn't bind failed. */
    failures: NodeJS.ErrnoException[];
}

/**
 * How often a port the OS picked is tried again when it turns out to be taken
 * on another address (the OS picks it free on the first address only).
 */
const PICK_ATTEMPTS = 5;

export class TlsDeviceLink implements DeviceLink {
    /** By address, one TLS server each, all on `port`. */
    private readonly listeners = new Map<string, Listener>();
    /** The addresses as last read, which is the order `addresses` reports them in. */
    private order: string[] = [];
    private port = 0;
    private options: tls.TlsOptions | null = null;
    private handlers: DeviceLinkHandlers | null = null;
    private http: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private keepalive: ReturnType<typeof setInterval> | null = null;
    private readonly peers = new WeakMap<Socket, Peer>();
    private readonly live = new Set<Live>();

    constructor(private readonly deps: TlsDeviceLinkDeps) {}

    public get listening(): boolean {
        return this.listeners.size > 0;
    }

    public get addresses(): readonly string[] {
        return this.order.filter((address) => this.listeners.has(address));
    }

    public async start(identity: ServerIdentity, port: number, handlers: DeviceLinkHandlers): Promise<number> {
        if (this.listening) throw new Error('The device link is already listening');
        const addresses = this.read();
        if (addresses.length === 0) throw new Error('No local network interface to listen on');

        // The HTTP server never listens: it only parses the upgrade request on
        // sockets the TLS servers have already authorised and hand to it.
        const httpServer = http.createServer((_req, res) => {
            res.writeHead(426, {Connection: 'close'});
            res.end();
        });
        const wss = new WebSocketServer({noServer: true, maxPayload: MAX_PAYLOAD_BYTES});
        httpServer.on('upgrade', (req, socket, head) => {
            const peer = this.peers.get(socket as Socket);
            if (!peer) return socket.destroy();
            wss.handleUpgrade(req, socket, head, (ws) => this.open(ws, peer, handlers));
        });
        this.http = httpServer;
        this.wss = wss;
        this.handlers = handlers;
        this.order = addresses;
        this.options = {
            key: identity.keyPem,
            cert: identity.certPem,
            minVersion: 'TLSv1.3',
            requestCert: true,
            rejectUnauthorized: false,
            handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        };

        let binding: Binding;
        if (port === 0) {
            binding = await this.pick(addresses);
        } else {
            binding = await this.bindEach(addresses, port);
            if (this.listeners.size === 0 && binding.failures.every(isAddressInUse)) {
                // The port the phones know is gone (something else took it): a
                // new one beats not listening at all.
                this.deps.log.warn(`[phone] port ${port} is taken on every address; picking a new one`);
                binding = await this.pick(addresses);
            }
        }
        if (this.listeners.size === 0) {
            this.http = null;
            this.wss = null;
            this.handlers = null;
            this.options = null;
            this.order = [];
            throw new Error(`Could not listen on any of ${addresses.join(', ')}`);
        }

        this.port = binding.port;
        this.keepalive = setInterval(() => this.ping(), this.deps.keepaliveMs ?? 20_000);
        this.keepalive.unref();
        return this.port;
    }

    /**
     * Follows the Mac's addresses without starting over: listens on the new
     * ones on the same port, and closes the servers of the ones that went away
     * along with the connections that came in on them (with `code`). Every
     * other connection stays open. When no address is left it stops.
     */
    public async updateAddresses(code: number, reason: string): Promise<AddressChange> {
        if (!this.listening) return {added: [], removed: []};
        const now = this.read();
        const removed = [...this.listeners.keys()].filter((address) => !now.includes(address));
        const fresh = now.filter((address) => !this.listeners.has(address));
        this.order = now;

        await Promise.all(removed.map((address) => this.unbind(address, code, reason)));
        if (removed.length > 0) this.deps.log.info(`[phone] stopped listening on ${removed.join(', ')}`);
        const added: string[] = [];
        for (const address of fresh) {
            try {
                await this.bind(address, this.port);
                added.push(address);
            } catch {
                // Logged by bind; that address simply has no listener.
            }
        }
        if (this.listeners.size === 0) await this.stop(code, reason);
        return {added, removed};
    }

    public async stop(code: number, reason: string): Promise<void> {
        if (this.http === null && this.listeners.size === 0) return;
        if (this.keepalive) clearInterval(this.keepalive);
        this.keepalive = null;

        for (const {ws} of this.live) ws.close(code, reason);
        await Promise.all([...this.listeners.keys()].map((address) => this.unbind(address, code, reason)));

        this.wss?.close();
        this.http = null;
        this.wss = null;
        this.handlers = null;
        this.options = null;
        this.order = [];
    }

    private read(): string[] {
        return (this.deps.addresses ?? (() => listenAddresses(os.networkInterfaces())))();
    }

    /**
     * Listens on every address on a port the OS picks. The OS only knows the
     * port is free on the first address, so when another address has it taken
     * everything is closed and picked again, a few times, rather than leaving
     * that address without a listener.
     */
    private async pick(addresses: string[]): Promise<Binding> {
        let binding = await this.bindEach(addresses, 0);
        for (let attempt = 1; attempt < PICK_ATTEMPTS; attempt++) {
            if (this.listeners.size === 0 || !binding.failures.some(isAddressInUse)) break;
            this.deps.log.info(`[phone] port ${binding.port} is taken on another address; picking again`);
            await Promise.all([...this.listeners.keys()].map((address) => this.unbind(address, 1001, 'Rebinding')));
            binding = await this.bindEach(addresses, 0);
        }
        return binding;
    }

    /** Binds each address on `port`; with 0, the first that binds picks the port the rest use. */
    private async bindEach(addresses: string[], port: number): Promise<Binding> {
        const failures: NodeJS.ErrnoException[] = [];
        let bound = port;
        for (const address of addresses) {
            try {
                bound = await this.bind(address, bound);
            } catch (err) {
                // One address that won't bind (it went away, it's taken) shouldn't
                // keep the others closed; none binding at all is the caller's call.
                failures.push(err as NodeJS.ErrnoException);
            }
        }
        return {port: bound, failures};
    }

    private async bind(address: string, port: number): Promise<number> {
        const handlers = this.handlers;
        const options = this.options;
        if (!handlers || !options) throw new Error('The device link is not started');
        const listener: Listener = {server: tls.createServer(options), sockets: new Set()};
        listener.server.on('secureConnection', (socket: tls.TLSSocket) =>
            this.secured(socket, address, listener, handlers),
        );
        listener.server.on('tlsClientError', (err) =>
            this.deps.log.debug('[phone] TLS handshake failed:', err.message),
        );
        try {
            const bound = await listen(listener.server, port, address);
            this.listeners.set(address, listener);
            this.deps.log.info(`[phone] listening on ${address} port ${bound}`);
            return bound;
        } catch (err) {
            this.deps.log.warn(`[phone] could not listen on ${address} port ${port}:`, (err as Error).message);
            throw err;
        }
    }

    /** Closes one address's server and the connections that came in on it. */
    private async unbind(address: string, code: number, reason: string): Promise<void> {
        const listener = this.listeners.get(address);
        if (!listener) return;
        this.listeners.delete(address);
        for (const live of this.live) if (live.address === address) live.ws.close(code, reason);
        const closed = new Promise<void>((resolve) => listener.server.close(() => resolve()));
        const grace = setTimeout(() => {
            for (const socket of listener.sockets) socket.destroy();
        }, STOP_GRACE_MS);
        await closed;
        clearTimeout(grace);
    }

    /** A completed TLS handshake: authorise it, or end it before any HTTP. */
    private secured(socket: tls.TLSSocket, address: string, listener: Listener, handlers: DeviceLinkHandlers): void {
        const fingerprint = fingerprintOf(socket);
        const grant = fingerprint ? this.authorize(handlers, fingerprint) : null;
        if (!fingerprint || !grant) {
            this.deps.log.info(
                `[phone] refused a connection from ${socket.remoteAddress}${fingerprint ? '' : ' (no certificate)'}`,
            );
            socket.destroy();
            return;
        }
        listener.sockets.add(socket);
        socket.on('close', () => listener.sockets.delete(socket));
        this.peers.set(socket, {fingerprint, grant, address});
        if (!this.http) {
            socket.destroy();
            return;
        }
        this.http.emit('connection', socket);
    }

    private authorize(handlers: DeviceLinkHandlers, fingerprint: string): ConnectionGrant {
        try {
            return handlers.authorize(fingerprint);
        } catch (err) {
            this.deps.log.error('[phone] authorize threw:', (err as Error).message);
            return null;
        }
    }

    private open(ws: WebSocket, peer: Peer, handlers: DeviceLinkHandlers): void {
        const {encodeTerminalFrame} = this.deps;
        const connection: DeviceConnection = {
            id: crypto.randomUUID(),
            fingerprint: peer.fingerprint,
            grant: peer.grant,
            send(message: ServerMessage) {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
            },
            sendTerminal(sessionId: string, data: string) {
                if (ws.readyState === WebSocket.OPEN) ws.send(encodeTerminalFrame(sessionId, data), {binary: true});
            },
            close(code: number, reason: string) {
                ws.close(code, reason);
            },
        };
        const live: Live = {ws, connection, missedPings: 0, address: peer.address};
        this.live.add(live);

        ws.on('pong', () => {
            live.missedPings = 0;
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary) return ws.close(CLOSE.protocolError, 'Binary frames are not accepted');
            const message = this.deps.parse(rawText(data));
            if (!message) return ws.close(CLOSE.protocolError, 'Malformed message');
            handlers.message(connection, message);
        });
        ws.on('error', (err) => this.deps.log.debug('[phone] connection error:', err.message));
        ws.on('close', () => {
            this.live.delete(live);
            handlers.disconnected(connection);
        });

        handlers.connected(connection);
    }

    private ping(): void {
        for (const live of this.live) {
            if (live.missedPings >= MISSED_PINGS_ALLOWED) {
                this.deps.log.info('[phone] dropping a connection that stopped answering pings');
                live.ws.terminate();
                continue;
            }
            live.missedPings++;
            live.ws.ping();
        }
    }
}

/** Lowercase hex SHA-256 of the client certificate's DER, or null without one. */
function fingerprintOf(socket: tls.TLSSocket): string | null {
    const cert = socket.getPeerCertificate();
    if (!cert || !cert.raw) return null;
    return crypto.createHash('sha256').update(cert.raw).digest('hex');
}

function rawText(data: Buffer | ArrayBuffer | Buffer[]): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return data.toString('utf8');
}

function isAddressInUse(err: NodeJS.ErrnoException): boolean {
    return err.code === 'EADDRINUSE';
}

function listen(server: tls.Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve((server.address() as AddressInfo).port);
        });
    });
}
