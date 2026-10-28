/**
 * Which task a session says it works on (#245), read from its transcript.
 *
 * A session handed "work on my task …" calls BlaakTasks' `update` and
 * `progress` tools with the task's id; that call is the evidence. What the
 * conversation says never counts — a task id in prose may be one Claude was
 * shown, asked about or ruled out — and neither does any other tool, `get` and
 * `list` included, which only look. A call BlaakTasks refused (an unknown id)
 * counts for nothing either.
 */
import { parseTranscriptLine } from '../session/transcript';
import { taskIdFrom } from './links';

/** The BlaakTasks tools whose `id` says the session works on that task. */
export const TASK_LINKING_TOOLS: readonly string[] = ['mcp__blaaktasks__update', 'mcp__blaaktasks__progress'];

/** The task a transcript's latest linking call names, and when it was made. */
export interface DetectedTask {
  taskId: string;
  /** Epoch ms of the call; null when its line carried no time. */
  at: number | null;
}

/** A content block, as far as detection reads one. Every field is best-effort. */
interface Block {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

function blocksOf(message: unknown): Block[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content.filter((block): block is Block => !!block && typeof block === 'object') : [];
}

/**
 * The task the session last said it works on, or null when it never called a
 * linking tool with a usable id. The latest call wins: a session that moved
 * on to another task has moved its link with it.
 */
export function detectTask(lines: readonly string[]): DetectedTask | null {
  const calls: Array<{ callId: unknown; found: DetectedTask }> = [];
  const refused = new Set<unknown>();
  for (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (!entry) continue;
    for (const block of blocksOf(entry.message)) {
      if (block.type === 'tool_result' && block.is_error === true) refused.add(block.tool_use_id);
      if (block.type !== 'tool_use' || typeof block.name !== 'string' || !TASK_LINKING_TOOLS.includes(block.name)) continue;
      const input = block.input && typeof block.input === 'object' ? (block.input as { id?: unknown }) : {};
      const taskId = taskIdFrom(input.id);
      if (!taskId) continue;
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      calls.push({ callId: block.id, found: { taskId, at: Number.isNaN(at) ? null : at } });
    }
  }
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].callId === undefined || !refused.has(calls[i].callId)) return calls[i].found;
  }
  return null;
}
