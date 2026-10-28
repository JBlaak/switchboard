/**
 * Reading BlaakTasks' tool replies into tasks (#252).
 *
 * A `tools/call` result is a list of text parts. The tools that return task
 * text put a notice first (that the text is data, not instructions), then the
 * compact JSON; the others send the JSON alone. So the JSON is the last part
 * that parses. A tool that refused (`isError`) says why in its text.
 *
 * Rows are checked field by field: a row without an id or a title is dropped,
 * an unknown status or effort reads as the default, and anything else missing
 * reads as empty, so a newer server's extra fields and an older server's
 * missing ones both still parse.
 */
import type { ProgressEntry, TaskDetail, TaskRow, TaskStatus } from './model';

const STATUSES: readonly TaskStatus[] = ['Not started', 'In progress', 'Waiting', 'Done', 'Dropped'];

/** A tool's answer: its JSON, or the reason it refused. */
export type ToolReply = { ok: true; value: unknown } | { ok: false; reason: string };

/** The JSON a `tools/call` result carries, or why the tool refused. */
export function readToolResult(result: unknown): ToolReply {
  if (!isRecord(result) || !Array.isArray(result.content)) return { ok: false, reason: 'BlaakTasks sent no content' };
  const texts = result.content
    .filter(isRecord)
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string);
  if (result.isError === true) return { ok: false, reason: texts.join(' ').trim() || 'BlaakTasks refused' };
  for (const text of [...texts].reverse()) {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      // The notice, or other prose: look further back.
    }
  }
  return { ok: false, reason: 'BlaakTasks sent no JSON' };
}

/** One row, or null when it has no id or title. */
export function parseTaskRow(value: unknown): TaskRow | null {
  if (!isRecord(value) || !nonEmpty(value.id) || !nonEmpty(value.title)) return null;
  return {
    id: value.id,
    context: value.database === 'private' ? 'private' : 'work',
    title: value.title,
    summary: text(value.summary),
    status: STATUSES.includes(value.status as TaskStatus) ? value.status as TaskStatus : 'Not started',
    deadline: text(value.deadline),
    dueLabel: text(value.dueLabel),
    today: value.today === true,
    effort: value.effort === 'Quick' || value.effort === 'Focus' ? value.effort : null,
    bucket: text(value.bucket),
    client: text(value.client),
    topic: text(value.topic),
    waitingOn: text(value.waitingOn),
    snoozedUntil: text(value.snoozedUntil),
    lastUpdate: text(value.lastUpdate),
    pullRequests: pullRequests(value),
  };
}

/** Every row of a list that parses, in order; [] for anything that isn't a list. */
export function parseTaskRows(value: unknown): TaskRow[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseTaskRow).filter((row): row is TaskRow => row !== null);
}

/** A `get` reply, or null when it isn't one task (an ambiguous reference answers with matches). */
export function parseTaskDetail(value: unknown): TaskDetail | null {
  const row = parseTaskRow(value);
  if (!row || !isRecord(value) || value.ambiguous === true) return null;
  return {
    ...row,
    notes: text(value.notes),
    url: typeof value.url === 'string' ? value.url : '',
    brief: typeof value.brief === 'string' ? value.brief : '',
    progress: Array.isArray(value.progress) ? value.progress.map(progressEntry).filter((entry): entry is ProgressEntry => entry !== null) : [],
  };
}

/** `pullRequests` when the server sends it, else the old single `pullRequest` (JBlaak/BlaakTasks#95). */
function pullRequests(row: Record<string, unknown>): string[] {
  if (Array.isArray(row.pullRequests)) return row.pullRequests.filter(nonEmpty);
  return nonEmpty(row.pullRequest) ? [row.pullRequest] : [];
}

function progressEntry(value: unknown): ProgressEntry | null {
  if (!isRecord(value) || typeof value.day !== 'string' || typeof value.text !== 'string') return null;
  return { day: value.day, text: value.text };
}

/** A string field, or null when it is missing, empty or not a string. */
function text(value: unknown): string | null {
  return nonEmpty(value) ? value : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
