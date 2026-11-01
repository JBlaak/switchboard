import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectTask } from '../src/domain/tasks/detect';

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

// Transcript lines in the shape the CLI writes them, as `parseTranscript` reads them.

function userText(text: string, timestamp = '2026-10-28T09:00:00.000Z'): string {
  return JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: text } });
}

function assistantText(text: string, timestamp = '2026-10-28T09:00:01.000Z'): string {
  return JSON.stringify({ type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

function toolCall(name: string, input: unknown, timestamp = '2026-10-28T09:00:02.000Z', callId = 'toolu_' + name + timestamp): string {
  return JSON.stringify({
    type: 'assistant', timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name, input }] },
  });
}

function toolResult(callId: string, isError: boolean): string {
  return JSON.stringify({
    type: 'user', timestamp: '2026-10-28T09:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, is_error: isError, content: 'ok' }] },
  });
}

test('an update call names the task the session works on, and when', () => {
  /* Given */
  const lines = [
    userText('work on my task ' + TASK),
    toolCall('mcp__blaaktasks__update', { id: TASK, status: 'In progress' }, '2026-10-28T09:05:00.000Z'),
  ];

  /* When */
  const detected = detectTask(lines);

  /* Then */
  assert.deepEqual(detected, { taskId: TASK, at: Date.parse('2026-10-28T09:05:00.000Z') });
});

test('a progress call names the task too', () => {
  /* Given */
  const lines = [toolCall('mcp__blaaktasks__progress', { id: TASK, text: 'opened PR #52' })];

  /* When */
  const detected = detectTask(lines);

  /* Then */
  assert.equal(detected?.taskId, TASK);
});

test('the latest call wins when a session moves to another task', () => {
  /* Given */
  const lines = [
    toolCall('mcp__blaaktasks__update', { id: TASK }, '2026-10-28T09:00:00.000Z'),
    toolCall('mcp__blaaktasks__progress', { id: OTHER, text: 'started' }, '2026-10-28T10:00:00.000Z'),
  ];

  /* When */
  const detected = detectTask(lines);

  /* Then */
  assert.equal(detected?.taskId, OTHER);
});

test('a task id in prose never counts', () => {
  /* Given */
  const lines = [
    userText('work on my task ' + TASK),
    assistantText('I will call mcp__blaaktasks__update with id ' + TASK),
  ];

  /* When */
  const detected = detectTask(lines);

  /* Then */
  assert.equal(detected, null);
});

test('other tools never count, BlaakTasks\' own get included', () => {
  /* Given */
  const lines = [
    toolCall('mcp__blaaktasks__get', { id: TASK }),
    toolCall('mcp__blaaktasks__star', { id: TASK }),
    toolCall('mcp__notion__update', { id: TASK }),
    toolCall('Bash', { command: 'echo ' + TASK, id: TASK }),
  ];

  /* When */
  const detected = detectTask(lines);

  /* Then */
  assert.equal(detected, null);
});

test('a call without a usable id never counts', () => {
  /* Given */
  const lines = [
    toolCall('mcp__blaaktasks__update', { id: 'my task' }),
    toolCall('mcp__blaaktasks__progress', { text: 'started' }),
    toolCall('mcp__blaaktasks__update', null),
  ];

  /* When */
  const detected = detectTask(lines);

  /* Then */
  assert.equal(detected, null);
});

test('a call BlaakTasks refused leaves the earlier one standing', () => {
  /* Given */
  const lines = [
    toolCall('mcp__blaaktasks__update', { id: TASK }, '2026-10-28T09:00:00.000Z', 'toolu_1'),
    toolResult('toolu_1', false),
    toolCall('mcp__blaaktasks__progress', { id: OTHER, text: 'started' }, '2026-10-28T10:00:00.000Z', 'toolu_2'),
    toolResult('toolu_2', true),
  ];

  /* When */
  const detected = detectTask(lines);

  /* Then */
  assert.equal(detected?.taskId, TASK);
});

test('a malformed line and a call without a time are read past', () => {
  /* Given */
  const lines = [
    '{not json',
    '',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__blaaktasks__update', input: { id: TASK } }] } }),
  ];

  /* When */
  const detected = detectTask(lines);

  /* Then */
  assert.deepEqual(detected, { taskId: TASK, at: null });
});
