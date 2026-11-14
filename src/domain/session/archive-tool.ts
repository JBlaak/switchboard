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
 * Only the slice of MCP the CLI needs to list and call its tools: `initialize`,
 * `tools/list`, `tools/call` and `ping`, answered as plain JSON (no streams, no
 * sessions), which Streamable HTTP allows.
 *
 * The same server offers more tools where the caller hands them in (`extra`):
 * on the Mac, `show_page` (`page-tool`) and `land` (`merge-manager/land-tool`).
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
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
};

/** What a tool call did: the text the session reads back, and whether that is an error. */
export interface ArchiveToolOutcome {
    ok: boolean;
    message: string;
}

/**
 * Another tool the server offers: what `tools/list` says of it, and what a
 * call does. A call may answer later (`land` asks GitHub); `archiveToolReply`
 * itself only takes tools that answer at once, so the server holds the reply
 * until a later answer settles.
 */
export interface McpTool<Outcome extends ArchiveToolOutcome | Promise<ArchiveToolOutcome> = ArchiveToolOutcome> {
    readonly definition: {
        readonly name: string;
        readonly title: string;
        readonly description: string;
        readonly inputSchema: Record<string, unknown>;
    };
    call(args: unknown): Outcome;
    /**
     * When to reach for the tool, for the server's `instructions`. The CLI puts
     * those in the session's system prompt, which matters because it may list
     * MCP tools by name only (deferred) and would never read the description.
     */
    readonly instructions?: string;
    /**
     * A prompt that goes with the tool, so the user can ask for it as a slash
     * command: the CLI lists a server's prompts as `/mcp__<server>__<name>`.
     * Tools alone never show up there.
     */
    readonly prompt?: McpPrompt;
}

/** A prompt without arguments: what `prompts/list` says of it, and the message `prompts/get` hands back. */
export interface McpPrompt {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly text: string;
}

/** A JSON-RPC response to send back, or null for a notification (answered with 202, no body). */
export type McpReply = Record<string, unknown> | null;

/**
 * The reply to one JSON-RPC message posted to the server. `archive` runs on a
 * call to the tool and says what came of it; `extra` are the other tools
 * offered, each called with the call's arguments.
 */
export function archiveToolReply(
    message: unknown,
    archive: () => ArchiveToolOutcome,
    extra: readonly McpTool[] = [],
): McpReply {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return rpcError(null, -32600, 'Invalid request');
    }
    const id = message.id;
    // A notification (`notifications/initialized`, a cancel) wants no answer.
    if (id === undefined) return null;
    if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'Invalid request');

    const prompts = extra.flatMap((tool) => (tool.prompt ? [tool.prompt] : []));
    switch (message.method) {
        case 'initialize': {
            const instructions = extra.flatMap((tool) => (tool.instructions ? [tool.instructions] : []));
            return rpcResult(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: prompts.length ? {tools: {}, prompts: {}} : {tools: {}},
                serverInfo: {name: ARCHIVE_TOOL_SERVER, version: '1'},
                ...(instructions.length ? {instructions: instructions.join('\n\n')} : {}),
            });
        }
        case 'ping':
            return rpcResult(id, {});
        case 'tools/list':
            return rpcResult(id, {tools: [TOOL, ...extra.map((tool) => tool.definition)]});
        case 'tools/call': {
            const params = isObject(message.params) ? message.params : {};
            const other = extra.find((tool) => tool.definition.name === params.name);
            if (params.name !== ARCHIVE_TOOL_NAME && !other)
                return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
            const outcome = other ? other.call(params.arguments) : archive();
            return rpcResult(id, {content: [{type: 'text', text: outcome.message}], isError: !outcome.ok});
        }
        case 'prompts/list':
            return rpcResult(id, {
                prompts: prompts.map(({name, title, description}) => ({name, title, description, arguments: []})),
            });
        case 'prompts/get': {
            const params = isObject(message.params) ? message.params : {};
            const prompt = prompts.find((p) => p.name === params.name);
            if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${String(params.name)}`);
            return rpcResult(id, {
                description: prompt.description,
                messages: [{role: 'user', content: {type: 'text', text: prompt.text}}],
            });
        }
        default:
            return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
}

/** The `--mcp-config` value that gives a session the tool, served at `url`. */
export function archiveToolMcpConfig(url: string, headers: Record<string, string>): string {
    return JSON.stringify({mcpServers: {[ARCHIVE_TOOL_SERVER]: {type: 'http', url, headers}}});
}

function rpcResult(id: string | number, result: Record<string, unknown>): Record<string, unknown> {
    return {jsonrpc: '2.0', id, result};
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
    return {jsonrpc: '2.0', id, error: {code, message}};
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
