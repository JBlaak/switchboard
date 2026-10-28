import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeJsonMcpServers } from '../src/infrastructure/claude-cli/mcp-servers';
import { NodeFileSystem } from '../src/infrastructure/fs/node-file-system';
import type { Logger } from '../src/application/ports/logger';

/**
 * The MCP config a capture call reads (#142, C2): one server, copied from
 * `~/.claude.json` into a file only the user can read, and gone afterwards.
 * The token is a stand-in; nothing here reads the real `~/.claude.json`.
 */

const TOKEN = 'fake-token-for-tests';
const ENTRY = { type: 'http', url: 'https://tasks.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } };

function harness(claudeJson: string | null = JSON.stringify({ mcpServers: { blaaktasks: ENTRY, james: { type: 'http', url: 'https://james' } } })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-test-'));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(temp);
  if (claudeJson !== null) fs.writeFileSync(path.join(home, '.claude.json'), claudeJson);
  const logged: string[] = [];
  const log: Logger = {
    debug: (...args) => logged.push(args.join(' ')), info: (...args) => logged.push(args.join(' ')),
    warn: (...args) => logged.push(args.join(' ')), error: (...args) => logged.push(args.join(' ')),
  };
  let n = 0;
  const servers = new ClaudeJsonMcpServers({
    fs: new NodeFileSystem(), homeDir: home, tempDir: temp, ids: { newId: () => `id-${++n}` }, log,
  });
  const left = () => fs.readdirSync(temp);
  return { servers, temp, left, logged, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('mcp servers: the config holds only that server, unchanged, readable by the user alone', (t) => {
  /* Given */
  const h = harness();
  t.after(h.cleanup);

  /* When */
  const config = h.servers.write('blaaktasks')!;

  /* Then */
  assert.equal(path.dirname(config.path), h.temp);
  assert.ok(!config.path.includes(TOKEN));
  assert.deepEqual(JSON.parse(fs.readFileSync(config.path, 'utf8')), { mcpServers: { blaaktasks: ENTRY } });
  assert.equal(fs.statSync(config.path).mode & 0o777, 0o600);
});

test('mcp servers: removing the config deletes it, and a second remove is harmless', (t) => {
  /* Given */
  const h = harness();
  t.after(h.cleanup);
  const config = h.servers.write('james')!;

  /* When */
  config.remove();
  config.remove();

  /* Then */
  assert.deepEqual(h.left(), []);
});

test('mcp servers: quitting removes every config still on disk', (t) => {
  /* Given */
  const h = harness();
  t.after(h.cleanup);
  h.servers.write('blaaktasks');
  h.servers.write('james');

  /* When */
  h.servers.removeAll();

  /* Then */
  assert.deepEqual(h.left(), []);
});

test('mcp servers: a server that is not set up, or no ~/.claude.json, writes nothing', (t) => {
  /* Given */
  const set = harness(JSON.stringify({ mcpServers: { james: {} } }));
  const none = harness(null);
  t.after(set.cleanup);
  t.after(none.cleanup);

  /* When */
  const results = [set.servers.has('blaaktasks'), set.servers.write('blaaktasks'), none.servers.has('james'), none.servers.write('james')];

  /* Then */
  assert.deepEqual(results, [false, null, false, null]);
  assert.deepEqual([set.left(), none.left()], [[], []]);
  assert.equal(set.servers.has('james'), true);
});

test('mcp servers: an unreadable ~/.claude.json counts as no server, and the log says nothing of what is in it', (t) => {
  /* Given */
  const h = harness(`{"mcpServers": {"blaaktasks": {"headers": {"Authorization": "Bearer ${TOKEN}"`);
  t.after(h.cleanup);

  /* When */
  const config = h.servers.write('blaaktasks');

  /* Then */
  assert.equal(config, null);
  assert.equal(h.logged.length, 1);
  assert.ok(!h.logged.join('\n').includes(TOKEN));
});

// ── Lookup by URL (#252) ──

test('mcp servers: the headers of the server with that URL, bearer and all', (t) => {
  /* Given */
  const h = harness();
  t.after(h.cleanup);

  /* When */
  const headers = h.servers.headersFor('https://tasks.example.com/mcp');

  /* Then */
  assert.deepEqual(headers, { Authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(h.left(), []);
  assert.deepEqual(h.logged, []);
});

test('mcp servers: a URL no server has, or no ~/.claude.json, has no headers', (t) => {
  /* Given */
  const h = harness();
  const none = harness(null);
  t.after(h.cleanup);
  t.after(none.cleanup);

  /* When */
  const results = [h.servers.headersFor('https://other.example.com/mcp'), none.servers.headersFor('https://tasks.example.com/mcp')];

  /* Then */
  assert.deepEqual(results, [null, null]);
});

test('mcp servers: an unreadable ~/.claude.json has no headers, and the log says nothing of what is in it', (t) => {
  /* Given */
  const h = harness(`{"mcpServers": {"blaaktasks": {"url": "https://tasks.example.com/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"`);
  t.after(h.cleanup);

  /* When */
  const headers = h.servers.headersFor('https://tasks.example.com/mcp');

  /* Then */
  assert.equal(headers, null);
  assert.ok(!h.logged.join('\n').includes(TOKEN));
});
