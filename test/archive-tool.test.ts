import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { ArchiveToolService } from '../src/application/services/archive-tool-service';
import { QuestionService } from '../src/application/services/question-service';
import { buildClaudeArgs } from '../src/domain/launch/claude-command';
import { QUESTION_HOOK_TOKEN_HEADER } from '../src/domain/questions/question';
import {
  ARCHIVE_TOOL_QUALIFIED_NAME, archiveToolMcpConfig, archiveToolReply,
} from '../src/domain/session/archive-tool';
import { QuestionHookServer } from '../src/infrastructure/http/question-hook-server';
import { fakePty, fakeRenderer, silentLog } from './support/fakes';

/**
 * A session archiving itself: the MCP slice the CLI speaks to list and call
 * `archive_session`, the request held until the turn ends, and both over the
 * hook server's real socket.
 */

function newSession(): ActiveSession {
  return new ActiveSession({
    pty: fakePty(),
    projectPath: '/repo',
    projectFolder: '-repo',
    knownTranscriptIds: new Set(),
    sessionSlug: null,
    isPlainTerminal: false,
    remote: null,
    openedAt: 0,
  });
}

function service(endpoint = { url: 'http://127.0.0.1:4321' as string | null, token: 'tok' }) {
  const registry = new SessionRegistry();
  const archived: string[] = [];
  const tool = new ArchiveToolService({
    registry, endpoint, log: silentLog,
    archiver: { archive: (sessionId) => { archived.push(sessionId); return { ok: true }; } },
  });
  return { registry, archived, tool };
}

const rpc = (method: string, params?: unknown, id = 1) =>
  ({ jsonrpc: '2.0', method, id, ...(params === undefined ? {} : { params }) });
const notification = (method: string) => ({ jsonrpc: '2.0', method });

const succeed = () => ({ ok: true, message: 'queued' });

// ── The protocol ──

test('initialize says the server has tools', () => {
  /* When */
  const reply = archiveToolReply(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }), succeed);

  /* Then */
  const result = (reply as { result: { capabilities: unknown; serverInfo: { name: string } } }).result;
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.serverInfo.name, 'switchboard');
});

test('the one tool listed is archive_session, taking no arguments', () => {
  /* When */
  const reply = archiveToolReply(rpc('tools/list'), succeed);

  /* Then */
  const { tools } = (reply as { result: { tools: Array<{ name: string; inputSchema: { properties: object } }> } }).result;
  assert.deepEqual(tools.map(t => t.name), ['archive_session']);
  assert.deepEqual(tools[0].inputSchema.properties, {});
});

test('calling the tool archives and reports back', () => {
  /* Given */
  let calls = 0;

  /* When */
  const reply = archiveToolReply(rpc('tools/call', { name: 'archive_session', arguments: {} }), () => { calls++; return { ok: true, message: 'queued' }; });

  /* Then */
  assert.equal(calls, 1);
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'queued' }], isError: false } });
});

test('a call that could not archive is a tool error, not a protocol error', () => {
  /* When */
  const reply = archiveToolReply(rpc('tools/call', { name: 'archive_session' }), () => ({ ok: false, message: 'no session' }));

  /* Then */
  assert.equal((reply as { result: { isError: boolean } }).result.isError, true);
});

test('another tool name is refused without archiving', () => {
  /* Given */
  let calls = 0;

  /* When */
  const reply = archiveToolReply(rpc('tools/call', { name: 'delete_everything' }), () => { calls++; return succeed(); });

  /* Then */
  assert.equal(calls, 0);
  assert.equal((reply as { error: { code: number } }).error.code, -32602);
});

test('notifications get no reply, unknown methods and junk get errors', () => {
  /* When */
  const notified = archiveToolReply(notification('notifications/initialized'), succeed);
  const unknown = archiveToolReply(rpc('resources/list'), succeed);
  const junk = archiveToolReply('not json-rpc', succeed);

  /* Then */
  assert.equal(notified, null);
  assert.equal((unknown as { error: { code: number } }).error.code, -32601);
  assert.equal((junk as { error: { code: number } }).error.code, -32600);
});

// ── The launch ──

test('a launch gets the server at its own path, with the token, and the tool pre-approved', () => {
  /* Given */
  const { tool } = service();

  /* When */
  const launch = tool.launchFor('abc');

  /* Then */
  assert.deepEqual(launch, {
    mcpConfig: archiveToolMcpConfig('http://127.0.0.1:4321/mcp/abc', { [QUESTION_HOOK_TOKEN_HEADER]: 'tok' }),
    allowedTools: [ARCHIVE_TOOL_QUALIFIED_NAME],
  });
  assert.equal(ARCHIVE_TOOL_QUALIFIED_NAME, 'mcp__switchboard__archive_session');
});

test('no server listening, no tool', () => {
  /* Given */
  const { tool } = service({ url: null, token: 'tok' });

  /* When */
  const launch = tool.launchFor('abc');

  /* Then */
  assert.equal(launch, null);
});

test('the tool goes on the command line ahead of the session flags', () => {
  /* When */
  const args = buildClaudeArgs({ sessionId: 'abc', isNew: true }, { initialPrompt: 'go' }, '{}', { mcpConfig: '{"mcpServers":{}}', allowedTools: ['mcp__a__b', 'mcp__c__d'] });

  /* Then */
  assert.deepEqual(args, [
    '--settings', '{}', '--mcp-config', '{"mcpServers":{}}', '--allowedTools', 'mcp__a__b,mcp__c__d',
    '--session-id', 'abc', '--', 'go',
  ]);
});

// ── Asking, then the turn ending ──

test('asking does not archive; the end of the turn does, once', () => {
  /* Given */
  const { registry, archived, tool } = service();
  registry.add('s1', newSession());

  /* When */
  const outcome = tool.request('s1');
  const beforeTurnEnds = [...archived];
  tool.turnEnded('s1');
  tool.turnEnded('s1');

  /* Then */
  assert.equal(outcome.ok, true);
  assert.deepEqual(beforeTurnEnds, []);
  assert.deepEqual(archived, ['s1']);
});

test('a turn ending in a session that never asked archives nothing', () => {
  /* Given */
  const { registry, archived, tool } = service();
  registry.add('s1', newSession());
  registry.add('s2', newSession());
  tool.request('s2');

  /* When */
  tool.turnEnded('s1');

  /* Then */
  assert.deepEqual(archived, []);
});

test('a session re-keyed after asking is archived under its current id', () => {
  /* Given */
  const { registry, archived, tool } = service();
  const session = newSession();
  registry.add('launch-id', session);
  tool.request('launch-id');
  session.realSessionId = 'forked-id';

  /* When */
  tool.turnEnded('launch-id');

  /* Then */
  assert.deepEqual(archived, ['forked-id']);
});

test('asking for a session Switchboard is not running fails', () => {
  /* Given */
  const { archived, tool } = service();

  /* When */
  const outcome = tool.request('ghost');
  tool.turnEnded('ghost');

  /* Then */
  assert.equal(outcome.ok, false);
  assert.deepEqual(archived, []);
});

// ── Over the hook server ──

async function harness() {
  const registry = new SessionRegistry();
  const archived: string[] = [];
  const server = new QuestionHookServer({
    receiver: {
      receive: (...args) => questions.receive(...args),
      receiveRound: (...args) => questions.receiveRound(...args),
      promptSubmitted: (...args) => questions.promptSubmitted(...args),
    },
    archiveTool: {
      request: (...args) => tool.request(...args),
      turnEnded: (...args) => tool.turnEnded(...args),
    },
    log: silentLog,
  });
  const questions = new QuestionService({
    registry, renderer: fakeRenderer(), endpoint: server, log: silentLog, clock: { now: () => 0 },
    prompter: { send: () => {}, onExit: () => ({ dispose() {} }) },
  });
  const tool = new ArchiveToolService({
    registry, endpoint: server, log: silentLog,
    archiver: { archive: (sessionId) => { archived.push(sessionId); return { ok: true }; } },
  });
  await server.start();
  registry.add('s1', newSession());
  const post = (path: string, body: unknown, token: string | null = server.token) => fetch(`${server.url}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { [QUESTION_HOOK_TOKEN_HEADER]: token } : {}) },
  });
  return { server, archived, post };
}

test('a session calls the tool over the socket and is archived when its turn ends', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());
  await h.post('/mcp/s1', rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } }));
  const initialized = await h.post('/mcp/s1', notification('notifications/initialized'));

  /* When */
  const called = await h.post('/mcp/s1', rpc('tools/call', { name: 'archive_session', arguments: {} }, 2));
  const body = await called.json() as { result: { isError: boolean } };
  const archivedMidTurn = [...h.archived];
  const stop = await h.post('/stop/s1', { hook_event_name: 'Stop', last_assistant_message: 'Done; archiving.' });

  /* Then */
  assert.equal(initialized.status, 202);
  assert.equal(body.result.isError, false);
  assert.deepEqual(archivedMidTurn, []);
  assert.deepEqual(await stop.json(), {});
  assert.deepEqual(h.archived, ['s1']);
});

test('the tool route needs the token', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());

  /* When */
  const res = await h.post('/mcp/s1', rpc('tools/call', { name: 'archive_session' }), null);
  await h.post('/stop/s1', { hook_event_name: 'Stop' });

  /* Then */
  assert.equal(res.status, 401);
  assert.deepEqual(h.archived, []);
});
