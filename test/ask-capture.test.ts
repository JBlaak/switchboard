import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUICK_ASK_SESSION, captureArgs, captureBootArgs, capturePrompt, captureSystemPrompt, mcpServerConfig,
  noAnswerLine, readCaptureRun, readUndoRun, undoArgs, undoBootArgs, undoPrompt, undoSystemPrompt,
} from '../src/domain/ask/capture';

/**
 * Quick Ask's captures (#142, C2–C6): the one-tool `claude -p` call that files
 * a task or a save, how its answer is read, and how it is taken back.
 */

const CONFIG = '/tmp/switchboard-mcp-1234.json';
const TOKEN = 'secret-token-abc';
const URL = 'https://tasks.example.com/mcp';

function envelope(answer: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: typeof answer === 'string' ? answer : JSON.stringify(answer),
    permission_denials: [],
    ...extra,
  });
}

function run(answer: unknown, extra: Record<string, unknown> = {}): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: envelope(answer, extra) + '\n', stderr: '' };
}

function flag(args: string[], name: string): string[] {
  return args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
}

// ── The server config ──

test('mcpServerConfig copies one server\'s entry, headers unchanged', () => {
  /* Given */
  const entry = { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` } };
  const claudeJson = { mcpServers: { blaaktasks: entry, james: { type: 'http', url: 'https://james' } }, projects: {} };

  /* When */
  const config = mcpServerConfig(claudeJson, 'blaaktasks');

  /* Then */
  assert.deepEqual(config, { mcpServers: { blaaktasks: entry } });
  assert.deepEqual(config?.mcpServers.blaaktasks, { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` } });
});

test('mcpServerConfig is null for a missing server', () => {
  /* Given */
  const claudeJsons: unknown[] = [{ mcpServers: { james: {} } }, { projects: {} }, null, 'nope', { mcpServers: { blaaktasks: 'x' } }];

  /* When */
  const configs = claudeJsons.map(json => mcpServerConfig(json, 'blaaktasks'));

  /* Then */
  assert.deepEqual(configs, [null, null, null, null, null]);
});

// ── Capturing ──

test('captureArgs are the boot args plus the message', () => {
  /* Given */
  const target = 'james' as const;

  /* When */
  const args = captureArgs(target, 'keep this', 'cap-1', CONFIG);

  /* Then */
  assert.deepEqual(args, [...captureBootArgs(target, CONFIG), capturePrompt(target, 'keep this', 'cap-1')]);
});

test('captureArgs allow exactly one tool, from the given config only', () => {
  /* Given */
  const targets = ['tasks', 'james'] as const;

  /* When */
  const argvs = targets.map(target => captureArgs(target, 'call Peter', 'cap-1', CONFIG));

  /* Then */
  assert.deepEqual(flag(argvs[0], '--allowedTools'), ['mcp__blaaktasks__capture']);
  assert.deepEqual(flag(argvs[1], '--allowedTools'), ['mcp__james__capture']);
  for (const args of argvs) {
    assert.deepEqual(flag(args, '--tools'), ['']);
    assert.deepEqual(flag(args, '--mcp-config'), [CONFIG]);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.deepEqual(args.slice(0, 7), ['-p', '--model', 'haiku', '--output-format', 'json', '--tools', '']);
    for (const name of ['--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(name));
    assert.deepEqual(flag(args, '--setting-sources'), ['']);
  }
});

test('captureArgs never carry the token or the server URL', () => {
  /* Given */
  const targets = ['tasks', 'james'] as const;

  /* When */
  const argvs = targets.map(target => captureArgs(target, 'call Peter', 'cap-1', CONFIG).join('\n'));

  /* Then */
  for (const argv of argvs) {
    assert.ok(!argv.includes(TOKEN));
    assert.ok(!argv.includes(URL));
    assert.ok(!argv.includes('Bearer'));
  }
});

test('BlaakTasks gets the text verbatim under the Quick Ask session', () => {
  /* Given */
  const text = 'Call Peter about the PRO Screen thursday';

  /* When */
  const system = captureSystemPrompt('tasks');
  const message = capturePrompt('tasks', text, 'cap-1');

  /* Then */
  assert.match(system, /mcp__blaaktasks__capture exactly once/);
  assert.ok(system.includes(`session set to "${QUICK_ASK_SESSION}"`));
  assert.match(system, /\{"ids": \[.*\], "summary": ".*"\}/);
  assert.equal(message, `Text:\n${text}`);
  assert.ok(!message.includes('cap-1'));
});

test('James gets the text verbatim with Switchboard\'s captureId', () => {
  /* Given */
  const text = 'https://example.com/glass';

  /* When */
  const system = captureSystemPrompt('james');
  const message = capturePrompt('james', text, 'cap-42');

  /* Then */
  assert.match(system, /mcp__james__capture exactly once/);
  assert.match(system, /captureId set to the given captureId/);
  assert.equal(message, `captureId: cap-42\n\nText:\n${text}`);
});

test('a capture answer becomes a receipt, its summary one line', () => {
  /* Given */
  const answer = '```json\n{"ids": ["t-1"], "summary": "Call Peter about the PRO Screen · due Thu\\nmore"}\n```';

  /* When */
  const receipt = readCaptureRun(run(answer), 'tasks');

  /* Then */
  assert.deepEqual(receipt, { target: 'tasks', ids: ['t-1'], summary: 'Call Peter about the PRO Screen · due Thu' });
});

test('a capture with no ids failed, with a line Patch can say', () => {
  /* Given */
  const answers = [{ ids: [], summary: '' }, { summary: 'Done' }, 'I saved it!', { ids: ['t-1', 3], summary: 'x' }];

  /* When */
  const results = answers.map(answer => readCaptureRun(run(answer), 'tasks'));

  /* Then */
  for (const result of results) assert.deepEqual(result, { kind: 'failed', reason: 'BlaakTasks didn’t answer. Try again?' });
});

test('a refused tool call failed, whatever Haiku answered', () => {
  /* Given */
  const refused = run({ ids: ['k-1'], summary: 'Kept' }, { permission_denials: [{ tool_name: 'mcp__james__capture' }] });

  /* When */
  const result = readCaptureRun(refused, 'james');

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: noAnswerLine('james') });
});

test('a failed call says the server didn\'t answer, or that the usage limit was hit', () => {
  /* Given */
  const crashed = { exitCode: 1, stdout: '', stderr: 'MCP server blaaktasks failed to connect' };
  const limited = { exitCode: 1, stdout: envelope('You\'ve hit your limit · resets 3pm', { is_error: true }) + '\n', stderr: '' };

  /* When */
  const results = [readCaptureRun(crashed, 'tasks'), readCaptureRun(limited, 'tasks')];

  /* Then */
  assert.deepEqual(results, [
    { kind: 'failed', reason: 'BlaakTasks didn’t answer. Try again?' },
    { kind: 'failed', reason: 'You’ve hit your usage limit — resets 3pm.' },
  ]);
});

// ── Undoing ──

test('undoArgs allow only the target\'s undo_capture', () => {
  /* Given */
  const ids = ['t-1', 't-2'];

  /* When */
  const tasks = undoArgs('tasks', ids, CONFIG);
  const james = undoArgs('james', ['k-1'], CONFIG);

  /* Then */
  assert.deepEqual(tasks, [...undoBootArgs('tasks', CONFIG), undoPrompt(ids)]);
  assert.deepEqual(flag(tasks, '--allowedTools'), ['mcp__blaaktasks__undo_capture']);
  assert.deepEqual(flag(james, '--allowedTools'), ['mcp__james__undo_capture']);
  assert.deepEqual(flag(james, '--mcp-config'), [CONFIG]);
  assert.equal(undoPrompt(ids), 'Ids:\n- t-1\n- t-2');
});

test('BlaakTasks undoes every id in one call; James one call per id', () => {
  /* Given */
  const targets = ['tasks', 'james'] as const;

  /* When */
  const [tasks, james] = targets.map(undoSystemPrompt);

  /* Then */
  assert.match(tasks, /exactly once, with ids set to every listed id/);
  assert.match(james, /once for each listed id, with id set to that id/);
});

test('an undo went through only when Haiku answers ok', () => {
  /* Given */
  const runs = [
    run({ ok: true }),
    run('```json\n{"ok": true}\n```'),
    run({ ok: false }),
    run({ ok: true }, { permission_denials: [{}] }),
    { exitCode: 1, stdout: '', stderr: 'boom' },
  ];

  /* When */
  const results = runs.map(readUndoRun);

  /* Then */
  assert.deepEqual(results, [true, true, false, false, false]);
});
