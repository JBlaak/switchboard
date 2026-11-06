/**
 * A stand-in BlaakTasks for the specs that switch it on: a local HTTP server
 * speaking MCP, found through `~/.claude.json` as the real one is, and the
 * Settings field that turns it on. No real BlaakTasks is ever reached.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {expect} from '@playwright/test';
import type {AddressInfo} from 'node:net';
import type {Page} from '@playwright/test';
import type {FixtureHome} from './fixture-home';

export const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
export const TITLE = 'Fix the flaky upload test';
/** A stand-in: no real server is ever reached. */
export const TOKEN = 'e2e-stand-in-token';

export interface ToolCall {
    tool: string;
    args: Record<string, unknown>;
    authorization: string | undefined;
}

/** A stand-in BlaakTasks on loopback: records each `tools/call` and answers with the task (with `task`'s fields over it). */
export async function fakeBlaakTasks(
    task: Record<string, unknown> = {},
): Promise<{url: string; calls: ToolCall[]; close(): Promise<void>}> {
    const calls: ToolCall[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            const request = JSON.parse(body) as {
                id: number;
                params: {name: string; arguments: Record<string, unknown>};
            };
            calls.push({
                tool: request.params.name,
                args: request.params.arguments,
                authorization: req.headers.authorization,
            });
            const answer = {
                id: TASK,
                title: TITLE,
                status: 'In progress',
                today: true,
                pullRequests: [],
                brief: '',
                progress: [],
                url: 'https://www.notion.so/x',
                ...task,
            };
            const value = request.params.name === 'list' ? [answer] : answer;
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {content: [{type: 'text', text: JSON.stringify(value)}]},
                }),
            );
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

/** BlaakTasks switched on the way a user does it: its URL saved in Settings. */
export async function switchBlaakTasksOn(page: Page, url: string): Promise<void> {
    await page.getByRole('button', {name: 'Global settings', exact: true}).click();
    await page.getByRole('menuitem', {name: 'All settings…'}).click();
    await page
        .getByText('Tasks URL', {exact: true})
        .locator('xpath=ancestor::*[.//input][1]')
        .getByRole('textbox')
        .fill(url);
    await page.getByRole('button', {name: 'Save Settings'}).click();
    await expect(page.getByText('Global Settings', {exact: true})).toBeHidden();
}

/** `~/.claude.json` naming the stand-in, with its token, as the user's own names the real one. */
export function writeBlaakTasksConfig(home: FixtureHome, url: string): void {
    fs.writeFileSync(
        path.join(home.home, '.claude.json'),
        JSON.stringify({mcpServers: {blaaktasks: {type: 'http', url, headers: {Authorization: `Bearer ${TOKEN}`}}}}),
    );
}
