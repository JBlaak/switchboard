/**
 * Pretending to be the IDE the Claude CLI is looking for.
 *
 * The CLI discovers an editor by scanning `~/.claude/ide` for lock files, each
 * naming a port and an auth token, and then speaks MCP to it over a WebSocket.
 * Answering that protocol is what puts a proposed edit in Switchboard's side
 * panel with accept/reject, instead of the CLI writing it straight to disk or
 * handing it to VS Code.
 *
 * One server per session, because the CLI finds its own through an environment
 * variable and the sessions have to stay distinguishable.
 *
 * The interesting part is that a diff is a *parked* RPC call: the CLI is
 * blocking on the answer while the user looks at it, so the promise is held
 * until the renderer says what happened — and every teardown path has to
 * resolve the ones still outstanding, or the CLI waits forever.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  DIFF_ACCEPTED, DIFF_REJECTED, DIFF_SAVED, INVALID_PARAMS, MCP_TOOLS, METHOD_NOT_FOUND,
  PROTOCOL_VERSION, SERVER_INFO, rpcError, rpcResult, textContent,
} from './protocol';
import type { RpcMessage } from './protocol';
import type { DiffAction, IdeBridge, IdeBridgeHandle } from '../../application/ports/ide-bridge';
import type { Logger } from '../../application/ports/logger';
import type { RendererGateway } from '../../application/ports/renderer-gateway';

/** How the user disposed of a diff. */
interface DiffOutcome {
  action: DiffAction;
  /** The edited buffer, for 'accept-edited'. */
  content?: string | null;
}

/** A diff on screen, with the RPC call parked until the user answers. */
interface PendingDiff {
  resolve(outcome: DiffOutcome): void;
  rpcId: string | number;
  tabName: string;
}

/** One session's server and its live connection. */
interface ServerEntry {
  sessionId: string;
  wss: WebSocketServer;
  port: number;
  authToken: string;
  lockFilePath: string;
  ws: WebSocket | null;
  pendingDiffs: Map<string, PendingDiff>;
}

/** The auth header the CLI sends, and the code we close on if it is wrong. */
const AUTH_HEADER = 'x-claude-code-ide-authorization';
const UNAUTHORIZED = 4001;

/** ws' numeric OPEN state. */
const WS_OPEN = 1;

export interface McpIdeBridgeDeps {
  renderer: RendererGateway;
  log: Logger;
  /** `~/.claude/ide` — where lock files advertise a running editor. */
  ideDir: string;
}

export class McpIdeBridge implements IdeBridge {
  readonly #servers = new Map<string, ServerEntry>();

  constructor(private readonly deps: McpIdeBridgeDeps) {}

  async start(sessionId: string, workspaceFolders: readonly string[]): Promise<IdeBridgeHandle> {
    const { log, ideDir } = this.deps;
    fs.mkdirSync(ideDir, { recursive: true });

    const port = await findFreePort();
    const authToken = crypto.randomUUID();

    const wss = new WebSocketServer({
      port,
      host: '127.0.0.1',
      handleProtocols: (protocols: Set<string>) => protocols.has('mcp') ? 'mcp' : false,
    });

    const lockFilePath = path.join(ideDir, `${port}.lock`);
    // 0600: the lock file carries the auth token for this session's bridge.
    fs.writeFileSync(lockFilePath, JSON.stringify({
      pid: process.pid,
      workspaceFolders,
      ideName: SERVER_INFO.name,
      transport: 'ws',
      runningInWindows: false,
      authToken,
    }), { encoding: 'utf8', mode: 0o600 });

    const entry: ServerEntry = {
      sessionId, wss, port, authToken, lockFilePath,
      ws: null, pendingDiffs: new Map(),
    };

    wss.on('connection', (ws: WebSocket, req: { headers: Record<string, unknown> }) => {
      if (req.headers[AUTH_HEADER] !== authToken) {
        log.warn(`[mcp] session=${entry.sessionId} rejected connection: bad auth`);
        ws.close(UNAUTHORIZED, 'Unauthorized');
        return;
      }
      log.info(`[mcp] session=${entry.sessionId} CLI connected on port ${port}`);

      // The CLI reconnects rather than reusing a connection it thinks is stale.
      if (entry.ws) {
        try { entry.ws.close(); } catch { /* already closing */ }
      }
      entry.ws = ws;

      ws.on('message', (data: { toString(): string }) => this.#handleMessage(entry, data.toString()));
      ws.on('close', () => {
        if (entry.ws === ws) entry.ws = null;
        log.debug(`[mcp] session=${entry.sessionId} CLI disconnected`);
      });
      ws.on('error', (err: Error) => log.debug(`[mcp] session=${entry.sessionId} ws error: ${err.message}`));
    });

    wss.on('error', (err: Error) => log.error(`[mcp] session=${sessionId} server error: ${err.message}`));

    this.#servers.set(sessionId, entry);
    log.info(`[mcp] session=${sessionId} server started on port ${port}`);
    return { port, authToken };
  }

  stop(sessionId: string): void {
    const entry = this.#servers.get(sessionId);
    if (!entry) return;

    // Anything the CLI is still blocking on has to be answered, or it hangs.
    this.#resolveAll(entry, { action: 'accept' });

    if (entry.ws) {
      try { entry.ws.close(); } catch { /* already closing */ }
    }
    try { entry.wss.close(); } catch { /* already closed */ }
    try { fs.unlinkSync(entry.lockFilePath); } catch { /* already gone */ }

    this.#servers.delete(sessionId);
  }

  stopAll(): void {
    for (const sessionId of [...this.#servers.keys()]) this.stop(sessionId);
  }

  rekey(oldSessionId: string, newSessionId: string): void {
    const entry = this.#servers.get(oldSessionId);
    if (!entry) return;
    this.#servers.delete(oldSessionId);
    entry.sessionId = newSessionId;
    this.#servers.set(newSessionId, entry);
  }

  resolveDiff(sessionId: string, diffId: string, action: DiffAction, editedContent: string | null): void {
    const entry = this.#servers.get(sessionId);
    const pending = entry?.pendingDiffs.get(diffId);
    if (!entry || !pending) return;
    entry.pendingDiffs.delete(diffId);
    pending.resolve({ action, content: editedContent });
  }

  /**
   * Remove lock files this process left behind.
   *
   * A crashed run leaves a port advertised that nothing is listening on, and
   * the CLI would try it. Only our own pid's files are touched: another
   * Switchboard instance's are live, and another editor's are not ours.
   */
  cleanStaleLocks(): void {
    const { ideDir, log } = this.deps;
    try {
      fs.mkdirSync(ideDir, { recursive: true });
      for (const file of fs.readdirSync(ideDir)) {
        if (!file.endsWith('.lock')) continue;
        const lockPath = path.join(ideDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { ideName?: string; pid?: number };
          if (data.ideName === SERVER_INFO.name && data.pid === process.pid) {
            fs.unlinkSync(lockPath);
            log.info(`[mcp] cleaned stale lock file: ${file}`);
          }
        } catch {
          // Not our lock file, or unparseable — leave it alone.
        }
      }
    } catch {
      // The IDE directory does not exist yet.
    }
  }

  // ── JSON-RPC ──

  #handleMessage(entry: ServerEntry, raw: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch {
      this.deps.log.warn('[mcp] received invalid JSON');
      return;
    }

    const { id, method, params } = message;

    // No id means a notification: nothing to answer.
    if (id === undefined || id === null) {
      if (method === 'notifications/initialized') {
        this.deps.log.info(`[mcp] session=${entry.sessionId} CLI initialized`);
      }
      return;
    }

    switch (method) {
      case 'initialize':
        return this.#send(entry, id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'tools/list':
        return this.#send(entry, id, { tools: MCP_TOOLS });
      case 'tools/call':
        void this.#handleToolCall(entry, id, params);
        return;
      default:
        this.deps.log.debug(`[mcp] session=${entry.sessionId} unhandled method: ${method}`);
        return this.#sendError(entry, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async #handleToolCall(
    entry: ServerEntry,
    rpcId: string | number,
    params: RpcMessage['params'],
  ): Promise<void> {
    const args = params?.arguments || {};
    switch (params?.name) {
      case 'openDiff': return this.#openDiff(entry, rpcId, args);
      case 'openFile': return this.#openFile(entry, rpcId, args);
      case 'close_tab': return this.#closeTab(entry, rpcId, args);
      case 'closeAllDiffTabs': return this.#closeAllDiffTabs(entry, rpcId);
      case 'getDiagnostics': return this.#send(entry, rpcId, textContent('[]'));
      default:
        return this.#sendError(entry, rpcId, INVALID_PARAMS, `Unknown tool: ${params?.name}`);
    }
  }

  /**
   * Show a diff and park the call until the user answers.
   *
   * The "old" side is read from disk rather than taken from the CLI, so the
   * diff is against what is actually there — a file changed since the CLI last
   * read it shows up as such. A file that does not exist reads as empty, which
   * renders as a whole-file addition.
   */
  async #openDiff(
    entry: ServerEntry,
    rpcId: string | number,
    args: Record<string, unknown>,
  ): Promise<void> {
    const oldFilePath = String(args.old_file_path ?? '');
    const newContent = String(args.new_file_contents ?? '');
    const tabName = String(args.tab_name ?? '');

    let oldContent = '';
    try {
      oldContent = fs.readFileSync(oldFilePath, 'utf8');
    } catch {
      this.deps.log.debug(`[mcp] ${oldFilePath} unreadable — treating it as a new file`);
    }

    const diffId = crypto.randomUUID();
    const answered = new Promise<DiffOutcome>((resolve) => {
      entry.pendingDiffs.set(diffId, { resolve, rpcId, tabName });
    });

    this.deps.renderer.openDiff(entry.sessionId, diffId, {
      oldFilePath, oldContent, newContent, tabName,
    });

    const outcome = await answered;
    if (outcome.action === 'accept-edited') {
      this.#send(entry, rpcId, textContent(DIFF_SAVED, outcome.content));
    } else if (outcome.action === 'accept') {
      this.#send(entry, rpcId, textContent(DIFF_ACCEPTED));
    } else {
      this.#send(entry, rpcId, textContent(DIFF_REJECTED));
    }
  }

  async #openFile(
    entry: ServerEntry,
    rpcId: string | number,
    args: Record<string, unknown>,
  ): Promise<void> {
    const filePath = String(args.filePath ?? '');
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      this.deps.log.debug(`[mcp] could not read ${filePath}: ${(err as Error).message}`);
    }

    this.deps.renderer.openFile(entry.sessionId, {
      filePath,
      content,
      preview: args.preview === true,
      startText: String(args.startText || ''),
      endText: String(args.endText || ''),
    });

    this.#send(entry, rpcId, textContent('ok'));
  }

  /** The CLI withdrew one diff: answer it as accepted and take it off screen. */
  async #closeTab(
    entry: ServerEntry,
    rpcId: string | number,
    args: Record<string, unknown>,
  ): Promise<void> {
    const tabName = String(args.tab_name ?? '');
    this.deps.log.debug(`[mcp] session=${entry.sessionId} close_tab: ${tabName}`);

    for (const [diffId, pending] of entry.pendingDiffs) {
      if (pending.tabName !== tabName) continue;
      entry.pendingDiffs.delete(diffId);
      pending.resolve({ action: 'accept' });
      this.deps.renderer.closeDiffTab(entry.sessionId, diffId);
      break;
    }

    this.#send(entry, rpcId, textContent('ok'));
  }

  async #closeAllDiffTabs(entry: ServerEntry, rpcId: string | number): Promise<void> {
    this.deps.log.debug(`[mcp] session=${entry.sessionId} closeAllDiffTabs`);
    this.#resolveAll(entry, { action: 'accept' });
    this.deps.renderer.closeAllDiffs(entry.sessionId);
    this.#send(entry, rpcId, textContent('ok'));
  }

  #resolveAll(entry: ServerEntry, outcome: DiffOutcome): void {
    for (const pending of entry.pendingDiffs.values()) pending.resolve(outcome);
    entry.pendingDiffs.clear();
  }

  #send(entry: ServerEntry, id: string | number, result: unknown): void {
    if (entry.ws?.readyState === WS_OPEN) entry.ws.send(rpcResult(id, result));
  }

  #sendError(entry: ServerEntry, id: string | number, code: number, message: string): void {
    if (entry.ws?.readyState === WS_OPEN) entry.ws.send(rpcError(id, code, message));
  }
}

/** Ask the OS for a free port by binding one and letting it go. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
