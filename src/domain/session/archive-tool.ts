/**
 * The tool a session archives itself with.
 *
 * Each local Claude session is launched with a small MCP server of
 * Switchboard's own (`--mcp-config`, an `http` server on the hook server's
 * loopback port) that offers one tool, `archive_session`, so the user can say
 * "archive your session when you're done" and leave. The tool doesn't archive
 * on the spot: that would kill the session mid-turn, before it has said what it
 * did. It asks for the archive, and the session is archived when its turn ends.
 *
 * Only the slice of MCP the CLI needs to list and call one tool: `initialize`,
 * `tools/list`, `tools/call` and `ping`, answered as plain JSON (no streams, no
 * sessions), which Streamable HTTP allows.
 */

/** The name the CLI registers the server under; the tool shows as `mcp__switchboard__archive_session`. */
export const ARCHIVE_TOOL_SERVER = 'switchboard';
export const ARCHIVE_TOOL_NAME = 'archive_session';
/** The tool's full name in the CLI, as `--allowedTools` takes it. */
export const ARCHIVE_TOOL_QUALIFIED_NAME = `mcp__${ARCHIVE_TOOL_SERVER}__${ARCHIVE_TOOL_NAME}`;

const PROTOCOL_VERSION = '2025-06-18';

const TOOL = {
  name: ARCHIVE_TOOL_NAME,
  title: 'Archive this session',
  description:
    'Archive this Claude session in Switchboard once the current turn ends: the session is stopped, ' +
    'its row moves to the archive, and (if the user switched that on) its worktrees are removed. ' +
    'Call it only when the user has asked for the session to be archived, as the last thing you do; ' +
    'finish your reply after calling it, and do not start further work.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/** What a tool call did: the text the session reads back, and whether that is an error. */
export interface ArchiveToolOutcome {
  ok: boolean;
  message: string;
}

/** A JSON-RPC response to send back, or null for a notification (answered with 202, no body). */
export type McpReply = Record<string, unknown> | null;

/**
 * The reply to one JSON-RPC message posted to the server. `archive` runs on a
 * call to the tool and says what came of it.
 */
export function archiveToolReply(message: unknown, archive: () => ArchiveToolOutcome): McpReply {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(null, -32600, 'Invalid request');
  }
  const id = message.id;
  // A notification (`notifications/initialized`, a cancel) wants no answer.
  if (id === undefined) return null;
  if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'Invalid request');

  switch (message.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: ARCHIVE_TOOL_SERVER, version: '1' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: [TOOL] });
    case 'tools/call': {
      const params = isObject(message.params) ? message.params : {};
      if (params.name !== ARCHIVE_TOOL_NAME) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
      const outcome = archive();
      return rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: !outcome.ok });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

/** The `--mcp-config` value that gives a session the tool, served at `url`. */
export function archiveToolMcpConfig(url: string, headers: Record<string, string>): string {
  return JSON.stringify({ mcpServers: { [ARCHIVE_TOOL_SERVER]: { type: 'http', url, headers } } });
}

function rpcResult(id: string | number, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
