/**
 * mcp-bridge.ts — Per-session WebSocket MCP server for Switchboard.
 *
 * Each Claude CLI PTY gets its own MCP server so the CLI can send
 * openDiff / openFile / closeAllDiffTabs / getDiagnostics calls
 * to Switchboard's file panel instead of a VS Code extension.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import type { BrowserWindow } from 'electron';

/** The log surface this module uses — electron-log satisfies it. */
export interface McpLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
  error(message: string): void;
}

/** How the user disposed of a diff the CLI asked us to show. */
export type DiffAction = 'accept' | 'accept-edited' | 'reject';

export interface DiffOutcome {
  action: DiffAction;
  /** The edited buffer, for 'accept-edited'. */
  content?: string | null;
}

/** A diff shown to the user, with the RPC call parked until they answer. */
interface PendingDiff {
  resolve: (outcome: DiffOutcome) => void;
  rpcId: string | number;
  tabName: string;
}

/** One session's MCP server and its live connection. */
interface ServerEntry {
  sessionId: string;
  wss: WebSocketServer;
  port: number;
  authToken: string;
  lockFilePath: string;
  mainWindow: BrowserWindow | null;
  ws: WebSocket | null;
  pendingDiffs: Map<string, PendingDiff>;
}

/** A JSON-RPC 2.0 request as the CLI sends it. */
interface RpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const IDE_DIR = path.join(os.homedir(), '.claude', 'ide');

// sessionId → ServerEntry
const servers = new Map<string, ServerEntry>();

// ── Helpers ──────────────────────────────────────────────────────────

function ensureIdeDir(): void {
  fs.mkdirSync(IDE_DIR, { recursive: true });
}

/** Get a random free port from the OS. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Build the JSON-RPC 2.0 response envelope. */
function rpcResult(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── MCP Tool Schemas ─────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'openDiff',
    description: 'Open a diff view for a file edit',
    inputSchema: {
      type: 'object',
      properties: {
        old_file_path: { type: 'string' },
        new_file_path: { type: 'string' },
        new_file_contents: { type: 'string' },
        tab_name: { type: 'string' },
      },
      required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'],
    },
  },
  {
    name: 'openFile',
    description: 'Open a file in the editor',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        preview: { type: 'boolean' },
        startText: { type: 'string' },
        endText: { type: 'string' },
        selectToEndOfLine: { type: 'boolean' },
        makeFrontmost: { type: 'boolean' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close a specific diff tab by name',
    inputSchema: {
      type: 'object',
      properties: { tab_name: { type: 'string' } },
      required: ['tab_name'],
    },
  },
  {
    name: 'closeAllDiffTabs',
    description: 'Close all open diff tabs',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getDiagnostics',
    description: 'Get diagnostics for a file',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string' } },
    },
  },
];

// ── JSON-RPC Message Handler ─────────────────────────────────────────

function handleMessage(entry: ServerEntry, raw: string, log: McpLogger): void {
  let msg: RpcMessage;
  try {
    msg = JSON.parse(raw) as RpcMessage;
  } catch {
    log.warn('[mcp] Received invalid JSON');
    return;
  }

  const { id, method, params } = msg;

  // Notifications (no id) — fire-and-forget
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      log.info(`[mcp] session=${entry.sessionId} CLI initialized`);
    }
    return;
  }

  // Requests (have id) — must respond
  switch (method) {
    case 'initialize':
      return sendResult(entry, id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'Switchboard', version: '1.0.0' },
      });

    case 'tools/list':
      return sendResult(entry, id, { tools: MCP_TOOLS });

    case 'tools/call':
      void handleToolCall(entry, id, params, log);
      return;

    default:
      log.debug(`[mcp] session=${entry.sessionId} unhandled method: ${method}`);
      return sendError(entry, id, -32601, `Method not found: ${method}`);
  }
}

function sendResult(entry: ServerEntry, id: string | number, result: unknown): void {
  if (entry.ws && entry.ws.readyState === 1) {
    entry.ws.send(rpcResult(id, result));
  }
}

function sendError(entry: ServerEntry, id: string | number, code: number, message: string): void {
  if (entry.ws && entry.ws.readyState === 1) {
    entry.ws.send(rpcError(id, code, message));
  }
}

// ── Tool Call Dispatch ───────────────────────────────────────────────

async function handleToolCall(
  entry: ServerEntry,
  rpcId: string | number,
  params: RpcMessage['params'],
  log: McpLogger,
): Promise<void> {
  const toolName = params?.name;
  const args = params?.arguments || {};

  switch (toolName) {
    case 'openDiff':
      return handleOpenDiff(entry, rpcId, args, log);
    case 'openFile':
      return handleOpenFile(entry, rpcId, args, log);
    case 'close_tab':
      return handleCloseTab(entry, rpcId, args, log);
    case 'closeAllDiffTabs':
      return handleCloseAllDiffTabs(entry, rpcId, log);
    case 'getDiagnostics':
      return handleGetDiagnostics(entry, rpcId);
    default:
      return sendError(entry, rpcId, -32602, `Unknown tool: ${toolName}`);
  }
}

async function handleOpenDiff(
  entry: ServerEntry,
  rpcId: string | number,
  args: Record<string, unknown>,
  log: McpLogger,
): Promise<void> {
  const old_file_path = String(args.old_file_path ?? '');
  const new_file_contents = String(args.new_file_contents ?? '');
  const tab_name = String(args.tab_name ?? '');

  // Read the current file from disk
  let oldContent = '';
  try {
    oldContent = fs.readFileSync(old_file_path, 'utf8');
  } catch {
    log.debug(`[mcp] Could not read ${old_file_path} — treating as new file`);
  }

  const diffId = crypto.randomUUID();

  // Create a promise that will be resolved when the user acts on the diff
  const diffPromise = new Promise<DiffOutcome>((resolve) => {
    entry.pendingDiffs.set(diffId, { resolve, rpcId, tabName: tab_name });
  });

  // Send to renderer
  if (entry.mainWindow && !entry.mainWindow.isDestroyed()) {
    entry.mainWindow.webContents.send('mcp-open-diff', entry.sessionId, diffId, {
      oldFilePath: old_file_path,
      oldContent,
      newContent: new_file_contents,
      tabName: tab_name,
    });
  }

  // Await user action
  const result = await diffPromise;

  // Send JSON-RPC response back to Claude CLI
  if (result.action === 'accept-edited') {
    // User accepted with edits — return FILE_SAVED + new content
    sendResult(entry, rpcId, {
      content: [
        { type: 'text', text: 'FILE_SAVED' },
        { type: 'text', text: result.content },
      ],
    });
  } else if (result.action === 'accept') {
    // User closed tab (accept as-is)
    sendResult(entry, rpcId, {
      content: [{ type: 'text', text: 'TAB_CLOSED' }],
    });
  } else {
    // User rejected
    sendResult(entry, rpcId, {
      content: [{ type: 'text', text: 'DIFF_REJECTED' }],
    });
  }
}

async function handleOpenFile(
  entry: ServerEntry,
  rpcId: string | number,
  args: Record<string, unknown>,
  log: McpLogger,
): Promise<void> {
  const filePath = String(args.filePath ?? '');
  const { preview, startText, endText } = args;

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log.debug(`[mcp] Could not read ${filePath}: ${(err as Error).message}`);
  }

  if (entry.mainWindow && !entry.mainWindow.isDestroyed()) {
    entry.mainWindow.webContents.send('mcp-open-file', entry.sessionId, {
      filePath,
      content,
      preview: preview ?? false,
      startText: startText || '',
      endText: endText || '',
    });
  }

  sendResult(entry, rpcId, {
    content: [{ type: 'text', text: 'ok' }],
  });
}

async function handleCloseTab(
  entry: ServerEntry,
  rpcId: string | number,
  args: Record<string, unknown>,
  log: McpLogger,
): Promise<void> {
  const tab_name = String(args.tab_name ?? '');
  log.debug(`[mcp] session=${entry.sessionId} close_tab: ${tab_name}`);

  // Find the pending diff by tab_name
  for (const [diffId, pending] of entry.pendingDiffs) {
    if (pending.tabName === tab_name) {
      entry.pendingDiffs.delete(diffId);
      pending.resolve({ action: 'accept' });

      // Notify renderer to close the tab
      if (entry.mainWindow && !entry.mainWindow.isDestroyed()) {
        entry.mainWindow.webContents.send('mcp-close-tab', entry.sessionId, diffId);
      }
      break;
    }
  }

  sendResult(entry, rpcId, {
    content: [{ type: 'text', text: 'ok' }],
  });
}

async function handleCloseAllDiffTabs(
  entry: ServerEntry,
  rpcId: string | number,
  log: McpLogger,
): Promise<void> {
  log.debug(`[mcp] session=${entry.sessionId} closeAllDiffTabs`);

  // Resolve all pending diffs as TAB_CLOSED
  for (const [, pending] of entry.pendingDiffs) {
    pending.resolve({ action: 'accept' });
  }
  entry.pendingDiffs.clear();

  if (entry.mainWindow && !entry.mainWindow.isDestroyed()) {
    entry.mainWindow.webContents.send('mcp-close-all-diffs', entry.sessionId);
  }

  sendResult(entry, rpcId, {
    content: [{ type: 'text', text: 'ok' }],
  });
}

async function handleGetDiagnostics(entry: ServerEntry, rpcId: string | number): Promise<void> {
  sendResult(entry, rpcId, {
    content: [{ type: 'text', text: '[]' }],
  });
}

// ── Public API ───────────────────────────────────────────────────────

/** Start an MCP WebSocket server for a session. */
export async function startMcpServer(
  sessionId: string,
  workspaceFolders: string[],
  mainWindow: BrowserWindow | null,
  log: McpLogger,
): Promise<{ port: number; authToken: string }> {
  ensureIdeDir();

  const port = await findFreePort();
  const authToken = crypto.randomUUID();

  const wss = new WebSocketServer({
    port,
    host: '127.0.0.1',
    handleProtocols: (protocols: Set<string>) => {
      if (protocols.has('mcp')) return 'mcp';
      return false;
    },
  });

  const lockFilePath = path.join(IDE_DIR, `${port}.lock`);
  const lockData = JSON.stringify({
    pid: process.pid,
    workspaceFolders,
    ideName: 'Switchboard',
    transport: 'ws',
    runningInWindows: false,
    authToken,
  });
  // Create lockfile only readable by user (it contains the MCP auth token)
  fs.writeFileSync(lockFilePath, lockData, { encoding: 'utf8', mode: 0o600 });

  const entry: ServerEntry = {
    sessionId,
    wss,
    port,
    authToken,
    lockFilePath,
    mainWindow,
    ws: null,
    pendingDiffs: new Map(),
  };

  wss.on('connection', (ws: WebSocket, req: { headers: Record<string, unknown> }) => {
    // Validate auth
    const headerAuth = req.headers['x-claude-code-ide-authorization'];
    if (headerAuth !== authToken) {
      log.warn(`[mcp] session=${sessionId} rejected connection: bad auth`);
      ws.close(4001, 'Unauthorized');
      return;
    }

    log.info(`[mcp] session=${sessionId} CLI connected on port ${port}`);

    // Close any previous connection
    if (entry.ws) {
      try { entry.ws.close(); } catch {}
    }
    entry.ws = ws;

    ws.on('message', (data: { toString(): string }) => {
      handleMessage(entry, data.toString(), log);
    });

    ws.on('close', () => {
      if (entry.ws === ws) entry.ws = null;
      log.debug(`[mcp] session=${sessionId} CLI disconnected`);
    });

    ws.on('error', (err: Error) => {
      log.debug(`[mcp] session=${sessionId} ws error: ${err.message}`);
    });
  });

  wss.on('error', (err: Error) => {
    log.error(`[mcp] session=${sessionId} server error: ${err.message}`);
  });

  servers.set(sessionId, entry);
  log.info(`[mcp] session=${sessionId} server started on port ${port}`);

  return { port, authToken };
}

/** Shut down the MCP server for a session. */
export function shutdownMcpServer(sessionId: string): void {
  const entry = servers.get(sessionId);
  if (!entry) return;

  // Resolve all pending diffs
  for (const [, pending] of entry.pendingDiffs) {
    pending.resolve({ action: 'accept' });
  }
  entry.pendingDiffs.clear();

  // Close WebSocket
  if (entry.ws) {
    try { entry.ws.close(); } catch {}
  }

  // Close server
  try { entry.wss.close(); } catch {}

  // Delete lock file
  try { fs.unlinkSync(entry.lockFilePath); } catch {}

  servers.delete(sessionId);
}

/** Shut down all MCP servers (app quit). */
export function shutdownAll(): void {
  for (const sessionId of servers.keys()) {
    shutdownMcpServer(sessionId);
  }
}

/** Resolve a pending diff from the renderer. */
export function resolvePendingDiff(
  sessionId: string,
  diffId: string,
  action: DiffAction,
  editedContent: string | null,
): void {
  const entry = servers.get(sessionId);
  if (!entry) return;

  const pending = entry.pendingDiffs.get(diffId);
  if (!pending) return;

  entry.pendingDiffs.delete(diffId);
  pending.resolve({ action, content: editedContent });
}

/** Re-key a server entry when session ID changes (e.g. fork). */
export function rekeyMcpServer(oldId: string, newId: string): void {
  const entry = servers.get(oldId);
  if (!entry) return;

  servers.delete(oldId);
  entry.sessionId = newId;
  servers.set(newId, entry);
}

/** Clean up stale lock files from previous Switchboard runs. */
export function cleanStaleLockFiles(log?: McpLogger): void {
  try {
    ensureIdeDir();
    const files = fs.readdirSync(IDE_DIR);
    for (const file of files) {
      if (!file.endsWith('.lock')) continue;
      const lockPath = path.join(IDE_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { ideName?: string; pid?: number };
        if (data.ideName === 'Switchboard' && data.pid === process.pid) {
          // Our PID but we didn't start it — stale from crash
          fs.unlinkSync(lockPath);
          if (log) log.info(`[mcp] Cleaned stale lock file: ${file}`);
        }
      } catch {
        // Not our lock file or can't parse — skip
      }
    }
  } catch {
    // IDE dir may not exist yet
  }
}

