/**
 * A session showing a page: `show_page` called on Switchboard's own MCP
 * server, at the address and with the token the session was launched with,
 * exactly as the CLI calls it.
 */
import {fakeClaude} from './fake-cli';
import type {FixtureHome} from './fixture-home';

interface McpServer {
    url: string;
    headers: Record<string, string>;
}

/** Call `show_page` as session `sessionId`; answers the tool's result. */
export async function showPage(
    home: FixtureHome,
    sessionId: string,
    page: {title: string; html: string},
): Promise<{isError: boolean; text: string}> {
    const launch = await fakeClaude(home, sessionId).launched();
    const at = launch.argv.indexOf('--mcp-config');
    if (at < 0) throw new Error(`session ${sessionId} was launched without --mcp-config`);
    const server = (JSON.parse(launch.argv[at + 1]) as {mcpServers: Record<string, McpServer>}).mcpServers.switchboard;

    const res = await fetch(server.url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', ...server.headers},
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {name: 'show_page', arguments: page},
        }),
    });
    if (!res.ok) throw new Error(`MCP server answered ${res.status}`);
    const {result} = (await res.json()) as {result: {isError: boolean; content: {text: string}[]}};
    return {isError: result.isError, text: result.content[0]?.text ?? ''};
}
