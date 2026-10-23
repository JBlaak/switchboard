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
 * Bound to the LAN interfaces only (see `lanAddresses`), one TLS server per
 * address, all on the same port. Never loopback-only (a phone couldn't reach
 * it), and never the wildcard address, which would also listen on VPN and
 * tunnel interfaces.
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
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import { CLOSE } from '../../domain/phone/protocol';
import type { ClientMessage, ServerMessage } from '../../domain/phone/protocol';
import type { Logger } from '../../application/ports/logger';
import type {
  ConnectionGrant, DeviceConnection, DeviceLink, DeviceLinkHandlers, ServerIdentity,
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
 * Interface names that are tunnels, VPNs or point-to-point links rather than
 * the local network: macOS's utun (Tailscale, WireGuard apps, iCloud Private
 * Relay), ipsec and ppp (system VPNs), tun/tap/wg (third-party VPNs), gif/stf
 * (IPv6 tunnelling), awdl/llw (AirDrop's peer-to-peer Wi-Fi), anpi, and
 * bridge/vmenet (Internet Sharing and virtual machines).
 */
const NON_LAN_INTERFACE = /^(utun|ipsec|ppp|tun|tap|wg|gif|stf|awdl|llw|anpi|bridge|vmenet)/;

/** 100.64.0.0/10, the carrier-grade NAT range Tailscale hands out, whatever the interface is called. */
const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/**
 * The addresses to listen on: every non-internal IPv4 and IPv6 address of an
 * interface that isn't a tunnel or VPN (see NON_LAN_INTERFACE), and not in the
 * CGNAT range. IPv6 link-local addresses carry their interface as a scope
 * (`fe80::1%en0`), which is what binding to one needs.
 */
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const addresses: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos || NON_LAN_INTERFACE.test(name)) continue;
    for (const info of infos) {
      if (info.internal) continue;
      if (info.family === 'IPv4') {
        if (!CGNAT.test(info.address)) addresses.push(info.address);
      } else if (info.address.toLowerCase().startsWith('fe80:')) {
        addresses.push(`${info.address.split('%')[0]}%${name}`);
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
  /** Where to listen; the LAN addresses by default. Tests pass loopback. */
  addresses?: () => string[];
  /** The ping interval; 20 s by default. */
  keepaliveMs?: number;
}

interface Peer {
  fingerprint: string;
  grant: Exclude<ConnectionGrant, null>;
}

interface Live {
  ws: WebSocket;
  connection: DeviceConnection;
  missedPings: number;
}

export class TlsDeviceLink implements DeviceLink {
  #servers: tls.Server[] = [];
  #http: http.Server | null = null;
  #wss: WebSocketServer | null = null;
  #keepalive: ReturnType<typeof setInterval> | null = null;
  readonly #sockets = new Set<tls.TLSSocket>();
  readonly #peers = new WeakMap<Socket, Peer>();
  readonly #live = new Set<Live>();

  constructor(private readonly deps: TlsDeviceLinkDeps) {}

  get listening(): boolean {
    return this.#servers.length > 0;
  }

  async start(identity: ServerIdentity, port: number, handlers: DeviceLinkHandlers): Promise<number> {
    if (this.listening) throw new Error('The device link is already listening');
    const addresses = (this.deps.addresses ?? (() => lanAddresses(os.networkInterfaces())))();
    if (addresses.length === 0) throw new Error('No local network interface to listen on');

    // The HTTP server never listens: it only parses the upgrade request on
    // sockets the TLS servers have already authorised and hand to it.
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(426, { Connection: 'close' });
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    httpServer.on('upgrade', (req, socket, head) => {
      const peer = this.#peers.get(socket as Socket);
      if (!peer) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => this.#open(ws, peer, handlers));
    });
    this.#http = httpServer;
    this.#wss = wss;

    const options: tls.TlsOptions = {
      key: identity.keyPem,
      cert: identity.certPem,
      minVersion: 'TLSv1.3',
      requestCert: true,
      rejectUnauthorized: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    };

    let bound = port;
    for (const address of addresses) {
      const server = tls.createServer(options, (socket) => this.#secured(socket, handlers));
      server.on('tlsClientError', (err) => this.deps.log.debug('[phone] TLS handshake failed:', err.message));
      try {
        bound = await listen(server, bound, address);
        this.#servers.push(server);
        this.deps.log.info(`[phone] listening on ${address} port ${bound}`);
      } catch (err) {
        // One address that won't bind (it went away, it's taken) shouldn't
        // keep the others closed; none binding at all is an error.
        this.deps.log.warn(`[phone] could not listen on ${address}:`, (err as Error).message);
      }
    }
    if (this.#servers.length === 0) {
      this.#http = null;
      this.#wss = null;
      throw new Error(`Could not listen on any of ${addresses.join(', ')}`);
    }

    this.#keepalive = setInterval(() => this.#ping(), this.deps.keepaliveMs ?? 20_000);
    this.#keepalive.unref();
    return bound;
  }

  async stop(code: number, reason: string): Promise<void> {
    const servers = this.#servers;
    if (servers.length === 0) return;
    this.#servers = [];
    if (this.#keepalive) clearInterval(this.#keepalive);
    this.#keepalive = null;

    for (const { ws } of this.#live) ws.close(code, reason);
    const closed = Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    const grace = setTimeout(() => {
      for (const socket of this.#sockets) socket.destroy();
    }, STOP_GRACE_MS);
    await closed;
    clearTimeout(grace);

    this.#wss?.close();
    this.#http = null;
    this.#wss = null;
  }

  /** A completed TLS handshake: authorise it, or end it before any HTTP. */
  #secured(socket: tls.TLSSocket, handlers: DeviceLinkHandlers): void {
    const fingerprint = fingerprintOf(socket);
    const grant = fingerprint ? this.#authorize(handlers, fingerprint) : null;
    if (!fingerprint || !grant) {
      this.deps.log.info(`[phone] refused a connection from ${socket.remoteAddress}${fingerprint ? '' : ' (no certificate)'}`);
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    this.#peers.set(socket, { fingerprint, grant });
    if (!this.#http) {
      socket.destroy();
      return;
    }
    this.#http.emit('connection', socket);
  }

  #authorize(handlers: DeviceLinkHandlers, fingerprint: string): ConnectionGrant {
    try {
      return handlers.authorize(fingerprint);
    } catch (err) {
      this.deps.log.error('[phone] authorize threw:', (err as Error).message);
      return null;
    }
  }

  #open(ws: WebSocket, peer: Peer, handlers: DeviceLinkHandlers): void {
    const { encodeTerminalFrame } = this.deps;
    const connection: DeviceConnection = {
      id: crypto.randomUUID(),
      fingerprint: peer.fingerprint,
      grant: peer.grant,
      send(message: ServerMessage) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      sendTerminal(sessionId: string, data: string) {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeTerminalFrame(sessionId, data), { binary: true });
      },
      close(code: number, reason: string) {
        ws.close(code, reason);
      },
    };
    const live: Live = { ws, connection, missedPings: 0 };
    this.#live.add(live);

    ws.on('pong', () => { live.missedPings = 0; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(CLOSE.protocolError, 'Binary frames are not accepted');
      const message = this.deps.parse(rawText(data));
      if (!message) return ws.close(CLOSE.protocolError, 'Malformed message');
      handlers.message(connection, message);
    });
    ws.on('error', (err) => this.deps.log.debug('[phone] connection error:', err.message));
    ws.on('close', () => {
      this.#live.delete(live);
      handlers.disconnected(connection);
    });

    handlers.connected(connection);
  }

  #ping(): void {
    for (const live of this.#live) {
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

function listen(server: tls.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
