/**
 * BlaakTasks over MCP, behind the BlaakTasks port (#252).
 *
 * BlaakTasks serves its tools as stateless Streamable HTTP: each call is one
 * JSON-RPC `tools/call` POSTed to the URL, with no `initialize` first and no
 * session to keep. The answer comes back as plain JSON or as a one-event SSE
 * stream, depending on the server; both are read. No model is involved.
 *
 * The URL is read from Settings on every call, and the headers from the
 * `~/.claude.json` server with that URL, so a change in either holds from the
 * next call. The headers carry the bearer token: they go into the request and
 * nowhere else. The log names the tool and how it ended, never a header, a
 * body or the URL.
 */
import { readToolResult, parseTaskDetail, parseTaskRow, parseTaskRows } from '../../domain/tasks/parse';
import type {
  BlaakTasksResult, TaskDetail, TaskListOptions, TaskPatch, TaskRow, TaskView,
} from '../../domain/tasks/model';
import type { BlaakTasks } from '../../application/ports/blaak-tasks';
import type { Logger } from '../../application/ports/logger';
import type { McpServers } from '../../application/ports/mcp-servers';

/** How long a call may take before BlaakTasks counts as unreachable. */
export const BLAAKTASKS_TIMEOUT_MS = 10_000;

/** The protocol revision the calls claim; a stateless server takes it without a handshake. */
const PROTOCOL_VERSION = '2025-06-18';

/** How one POST ended: the JSON-RPC result, or why there is none. */
type Posted = Extract<BlaakTasksResult<unknown>, { kind: 'ok' | 'unreachable' | 'failed' }>;

export interface McpBlaakTasksDeps {
  /** The URL in Settings, '' while BlaakTasks is off. */
  url(): string;
  mcpServers: Pick<McpServers, 'headersFor'>;
  log: Logger;
  timeoutMs?: number;
}

export class McpBlaakTasks implements BlaakTasks {
  #nextId = 0;

  constructor(private readonly deps: McpBlaakTasksDeps) {}

  list(view: TaskView, options: TaskListOptions = {}): Promise<BlaakTasksResult<TaskRow[]>> {
    return this.#call('list', { view, ...options }, parseTaskRows);
  }

  get(id: string): Promise<BlaakTasksResult<TaskDetail>> {
    return this.#call('get', { task: id }, parseTaskDetail);
  }

  update(id: string, patch: TaskPatch): Promise<BlaakTasksResult<TaskRow>> {
    return this.#call('update', { ...patch, id }, parseTaskRow);
  }

  progress(id: string, text: string, pullRequest?: string): Promise<BlaakTasksResult<TaskRow>> {
    return this.#call('progress', { id, text, ...(pullRequest ? { pullRequest } : {}) }, parseTaskRow);
  }

  /** One `tools/call`, read with `parse`; a null from it means the reply wasn't what the tool sends. */
  async #call<T>(
    tool: string, args: Record<string, unknown>, parse: (value: unknown) => T | null,
  ): Promise<BlaakTasksResult<T>> {
    const { log } = this.deps;
    const url = this.deps.url().trim();
    if (!url) return { kind: 'off' };
    const headers = this.deps.mcpServers.headersFor(url);
    if (!headers) return { kind: 'notSetUp' };

    const answer = await this.#post(url, headers, tool, args);
    if (answer.kind !== 'ok') {
      log.warn(`[blaaktasks] ${tool}: ${answer.kind}: ${answer.reason}`);
      return answer;
    }
    const reply = readToolResult(answer.value);
    const value = reply.ok ? parse(reply.value) : null;
    if (value === null) {
      const reason = reply.ok ? 'BlaakTasks sent something else' : reply.reason;
      log.warn(`[blaaktasks] ${tool}: failed`);
      return { kind: 'failed', reason };
    }
    return { kind: 'ok', value };
  }

  /** POST the request; the JSON-RPC `result`, or how it went wrong. */
  async #post(
    url: string, headers: Record<string, string>, tool: string, args: Record<string, unknown>,
  ): Promise<Posted> {
    const id = ++this.#nextId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? BLAAKTASKS_TIMEOUT_MS);
    try {
      const res = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }),
        signal: controller.signal,
      });
      const body = await res.text();
      if (res.status >= 500) return { kind: 'unreachable', reason: `BlaakTasks answered ${res.status}` };
      if (!res.ok) return { kind: 'failed', reason: `BlaakTasks answered ${res.status}` };
      const message = rpcResponse(body, res.headers.get('content-type') ?? '', id);
      if (!message) return { kind: 'failed', reason: 'BlaakTasks sent no answer' };
      if (isRecord(message.error)) {
        const reason = typeof message.error.message === 'string' ? message.error.message : 'JSON-RPC error';
        return { kind: 'failed', reason };
      }
      return { kind: 'ok', value: message.result };
    } catch (err) {
      const reason = controller.signal.aborted ? 'timed out' : (err as Error).message;
      return { kind: 'unreachable', reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The JSON-RPC response to request `id` in a body: the body itself when it is
 * JSON, or the `data:` of the SSE event that carries it.
 */
export function rpcResponse(body: string, contentType: string, id: number): Record<string, unknown> | null {
  const candidates = contentType.includes('text/event-stream')
    ? sseData(body)
    : [body];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) && parsed.id === id) return parsed;
    } catch {
      // Not JSON: a keep-alive or something else; the next event may be it.
    }
  }
  return null;
}

/** Each SSE event's data, its `data:` lines joined. */
function sseData(body: string): string[] {
  return body.split(/\r?\n\r?\n/).map(event => event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n'))
    .filter(data => data !== '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
