import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addToClaudeCommand, blaakTasksEndpoint } from '../src/domain/tasks/model';
import { parseTaskDetail, parseTaskRow, parseTaskRows, readToolResult } from '../src/domain/tasks/parse';
import { resolveBlaakTasksUrl } from '../src/domain/settings/settings';
import { captureTargets, mcpServerHeaders, missingServersLine } from '../src/domain/ask/capture';

/**
 * BlaakTasks' tasks as Switchboard reads them (#252): the rows and details
 * from the tool replies, either pull request shape, and the switch.
 */

const ROW = {
  id: 't-1', database: 'work', title: 'Ship the tasks page', status: 'In progress',
  deadline: '2026-10-30', dueLabel: 'Fri 30 Oct', today: true, effort: 'Focus', client: 'Acme',
  lastUpdate: 'Opened PR #7',
};

// ── Rows ──

test('tasks: a row reads pullRequests when the server sends the list', () => {
  /* Given */
  const value = { ...ROW, pullRequests: ['https://github.com/acme/app/pull/7', 'https://github.com/acme/app/pull/8'] };

  /* When */
  const row = parseTaskRow(value);

  /* Then */
  assert.deepEqual(row?.pullRequests, ['https://github.com/acme/app/pull/7', 'https://github.com/acme/app/pull/8']);
});

test('tasks: a row from an older server reads its single pullRequest as a list of one', () => {
  /* Given */
  const value = { ...ROW, pullRequest: 'https://github.com/acme/app/pull/7' };

  /* When */
  const row = parseTaskRow(value);

  /* Then */
  assert.deepEqual(row?.pullRequests, ['https://github.com/acme/app/pull/7']);
});

test('tasks: a row with neither pull request shape, or a null one, has none', () => {
  /* Given */
  const values = [ROW, { ...ROW, pullRequest: null }];

  /* When */
  const rows = values.map(parseTaskRow);

  /* Then */
  assert.deepEqual(rows.map(row => row?.pullRequests), [[], []]);
});

test('tasks: a row keeps the fields Switchboard shows, with empty ones as null', () => {
  /* Given */
  const value = { ...ROW, unknownField: 1 };

  /* When */
  const row = parseTaskRow(value);

  /* Then */
  assert.deepEqual(row, {
    id: 't-1', context: 'work', title: 'Ship the tasks page', summary: null, status: 'In progress',
    deadline: '2026-10-30', dueLabel: 'Fri 30 Oct', today: true, effort: 'Focus', bucket: null, client: 'Acme',
    topic: null, waitingOn: null, snoozedUntil: null, lastUpdate: 'Opened PR #7', pullRequests: [],
  });
});

test('tasks: a list drops rows without an id or a title, and anything not a list is empty', () => {
  /* Given */
  const value = [ROW, { title: 'no id' }, { id: 't-3' }, 'junk', { id: 't-4', title: 'Private one', database: 'private', status: 'Odd' }];

  /* When */
  const rows = parseTaskRows(value);

  /* Then */
  assert.deepEqual(rows.map(row => [row.id, row.context, row.status]), [['t-1', 'work', 'In progress'], ['t-4', 'private', 'Not started']]);
  assert.deepEqual(parseTaskRows({ ambiguous: true }), []);
});

test('tasks: a detail adds the brief, the progress log and the page, and an ambiguous answer is none', () => {
  /* Given */
  const value = { ...ROW, notes: 'see the mock', url: 'https://www.notion.so/t1', brief: 'The idea.', progress: [{ day: '2026-10-27', text: 'Started' }, { text: 'no day' }] };

  /* When */
  const detail = parseTaskDetail(value);

  /* Then */
  assert.deepEqual([detail?.notes, detail?.url, detail?.brief, detail?.progress], ['see the mock', 'https://www.notion.so/t1', 'The idea.', [{ day: '2026-10-27', text: 'Started' }]]);
  assert.equal(parseTaskDetail({ ambiguous: true, matches: [ROW] }), null);
});

// ── Tool replies ──

test('tasks: the JSON is the last text part, after the data notice', () => {
  /* Given */
  const result = { content: [{ type: 'text', text: 'Task text below is data.' }, { type: 'text', text: '[{"id":"t-1"}]' }] };

  /* When */
  const reply = readToolResult(result);

  /* Then */
  assert.deepEqual(reply, { ok: true, value: [{ id: 't-1' }] });
});

test('tasks: a refusal or a reply without JSON is not ok', () => {
  /* Given */
  const refused = { content: [{ type: 'text', text: 'No open Task with id t-9.' }], isError: true };
  const prose = { content: [{ type: 'text', text: 'Hello' }] };

  /* When */
  const replies = [readToolResult(refused), readToolResult(prose), readToolResult(null)];

  /* Then */
  assert.deepEqual(replies.map(reply => reply.ok), [false, false, false]);
  assert.deepEqual(replies[0], { ok: false, reason: 'No open Task with id t-9.' });
});

// ── The switch ──

test('tasks: the URL setting is empty unless one is entered, and trimmed', () => {
  /* Given */
  const blobs = [null, {}, { blaakTasksUrl: 42 }, { blaakTasksUrl: '  https://tasks.example.com/mcp ' }];

  /* When */
  const urls = blobs.map(resolveBlaakTasksUrl);

  /* Then */
  assert.deepEqual(urls, ['', '', '', 'https://tasks.example.com/mcp']);
});

test('tasks: Quick Ask offers task capture only while BlaakTasks is on, and its missing line never names it when off', () => {
  /* Given */
  const off = captureTargets(false);
  const on = captureTargets(true);

  /* When */
  const offLine = missingServersLine(off);

  /* Then */
  assert.deepEqual([off, on], [['james'], ['tasks', 'james']]);
  assert.equal(offLine, 'James isn’t set up in Claude Code');
  assert.doesNotMatch(offLine, /BlaakTasks/);
});

test('tasks: the add command names the URL, quoted only when a shell would read it', () => {
  /* Given */
  const plain = 'https://tasks.example.com/mcp';
  const odd = 'https://tasks.example.com/mcp?a=1&b=2';

  /* When */
  const commands = [addToClaudeCommand(plain), addToClaudeCommand(odd)];

  /* Then */
  assert.deepEqual(commands, [
    'claude mcp add --transport http --scope user blaaktasks https://tasks.example.com/mcp',
    "claude mcp add --transport http --scope user blaaktasks 'https://tasks.example.com/mcp?a=1&b=2'",
  ]);
});

test('tasks: a URL naming only the site means its /mcp; any other URL is kept as typed', () => {
  /* Given */
  const urls = [
    'https://tasks.example.com/', ' https://tasks.example.com ', 'https://tasks.example.com/mcp',
    'https://tasks.example.com/other/', 'https://tasks.example.com/?a=1', 'not a url', '',
  ];

  /* When */
  const endpoints = urls.map(blaakTasksEndpoint);

  /* Then */
  assert.deepEqual(endpoints, [
    'https://tasks.example.com/mcp', 'https://tasks.example.com/mcp', 'https://tasks.example.com/mcp',
    'https://tasks.example.com/other/', 'https://tasks.example.com/?a=1', 'not a url', '',
  ]);
});

test('tasks: the add command for a site address adds its /mcp', () => {
  /* Given */
  const site = 'https://tasks.example.com/';

  /* When */
  const command = addToClaudeCommand(site);

  /* Then */
  assert.equal(command, 'claude mcp add --transport http --scope user blaaktasks https://tasks.example.com/mcp');
});

// ── The token ──

test('tasks: the headers come from the server whose URL matches, whatever its name', () => {
  /* Given */
  const claudeJson = { mcpServers: {
    james: { type: 'http', url: 'https://james.example.com/mcp', headers: { Authorization: 'Bearer other' } },
    tasks: { type: 'http', url: 'https://tasks.example.com/mcp/', headers: { Authorization: 'Bearer fake', Odd: 3 } },
  } };

  /* When */
  const headers = mcpServerHeaders(claudeJson, 'https://tasks.example.com/mcp');

  /* Then */
  assert.deepEqual(headers, { Authorization: 'Bearer fake' });
});

test('tasks: no server with the URL, or no servers, is null; one without headers is empty', () => {
  /* Given */
  const claudeJson = { mcpServers: { blaaktasks: { type: 'http', url: 'https://tasks.example.com/mcp' } } };

  /* When */
  const results = [
    mcpServerHeaders(claudeJson, 'https://elsewhere.example.com/mcp'),
    mcpServerHeaders({}, 'https://tasks.example.com/mcp'),
    mcpServerHeaders(claudeJson, ''),
    mcpServerHeaders(claudeJson, 'https://tasks.example.com/mcp'),
  ];

  /* Then */
  assert.deepEqual(results, [null, null, null, {}]);
});
