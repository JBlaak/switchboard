/**
 * The slice of MCP the Claude CLI expects from an editor.
 *
 * JSON-RPC 2.0 over a WebSocket: the CLI handshakes, asks what tools exist,
 * then calls them. Only five tools matter, and only two of them do anything —
 * showing a diff and opening a file. `getDiagnostics` answers empty because
 * Switchboard is not a language server, and the close-tab calls exist so the
 * CLI can withdraw a diff it no longer wants an answer to.
 */

/** A JSON-RPC 2.0 request as the CLI sends it. */
export interface RpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

export const PROTOCOL_VERSION = '2025-03-26';

export const SERVER_INFO = { name: 'Switchboard', version: '1.0.0' };

/** What `tools/list` answers with. */
export const MCP_TOOLS = [
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

export function rpcResult(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export function rpcError(id: string | number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Every tool answer is a content list; these are the ones we send. */
export function textContent(...texts: (string | null | undefined)[]): { content: { type: string; text: string }[] } {
  return { content: texts.filter((t): t is string => t != null).map(text => ({ type: 'text', text })) };
}

/**
 * The words the CLI reads back from a diff.
 *
 * FILE_SAVED means "the user edited it, here is the result"; TAB_CLOSED means
 * "accepted as-is"; DIFF_REJECTED means "do not apply this".
 */
export const DIFF_SAVED = 'FILE_SAVED';
export const DIFF_ACCEPTED = 'TAB_CLOSED';
export const DIFF_REJECTED = 'DIFF_REJECTED';

/** JSON-RPC's own code for an unknown method. */
export const METHOD_NOT_FOUND = -32601;
/** …and for a call it cannot make sense of. */
export const INVALID_PARAMS = -32602;
