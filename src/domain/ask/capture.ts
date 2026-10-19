/**
 * Quick Ask's captures (#142, C2–C6): a task into BlaakTasks, or something to
 * keep into James.
 *
 * The write is one `claude -p` call with Haiku, with the built-in tools off and
 * exactly one MCP tool allowed, against a config holding only that server. The
 * config is a file main writes from `~/.claude.json` and deletes afterwards, so
 * the server's token never appears in argv. Haiku passes the text on verbatim;
 * the server parses dates and context itself.
 */
import type { CaptureTarget } from './model';
import { parseAnswerObject } from './quick-route';
import { parseEnvelope, usageLimitLine } from './route';
import type { ClaudeRun } from './route';

/** What a capture stored, for the saved line and for ⌘Z. */
export interface CaptureReceipt {
  target: CaptureTarget;
  /** The ids the server returned; `undo_capture` takes them back. */
  ids: string[];
  /** One line, e.g. "Call Peter about the PRO Screen · due Thu". */
  summary: string;
}

/** Each target's server, as `~/.claude.json` names it under `mcpServers`. */
export const CAPTURE_SERVERS: Record<CaptureTarget, string> = { tasks: 'blaaktasks', james: 'james' };

/** The `session` BlaakTasks files a Quick Ask task under (C3). */
export const QUICK_ASK_SESSION = 'Switchboard Quick Ask';

/** Longest a summary may run before it's cut short. */
const MAX_SUMMARY = 100;

const TARGET_NAMES: Record<CaptureTarget, string> = { tasks: 'BlaakTasks', james: 'James' };

export function captureTool(target: CaptureTarget): string {
  return `mcp__${CAPTURE_SERVERS[target]}__capture`;
}

export function undoTool(target: CaptureTarget): string {
  return `mcp__${CAPTURE_SERVERS[target]}__undo_capture`;
}

// ── The server config ──

/**
 * The `--mcp-config` content for one server: its entry from the parsed
 * `~/.claude.json`, copied unchanged, or null when it isn't there (C6).
 */
export function mcpServerConfig(claudeJson: unknown, name: string): { mcpServers: Record<string, unknown> } | null {
  if (!isRecord(claudeJson) || !isRecord(claudeJson.mcpServers)) return null;
  const entry = claudeJson.mcpServers[name];
  if (!isRecord(entry)) return null;
  return { mcpServers: { [name]: entry } };
}

// ── Capturing ──

const ANSWER_LINES = [
  'Answering:',
  '- Answer with only this JSON object, no prose, no code fence:',
  '  {"ids": ["<each id the tool returned>"], "summary": "<one line>"}',
];

/** Who Haiku is for a capture: one tool call with the text verbatim, then the receipt. */
export function captureSystemPrompt(target: CaptureTarget): string {
  const tool = captureTool(target);
  const call = target === 'tasks'
    ? [
        `- Call ${tool} exactly once, with text set to everything after the "Text:" line, exactly as written, and session set to "${QUICK_ASK_SESSION}". Pass no other fields.`,
        '- summary: the task\'s title as the tool returned it, then " · due <weekday>" when it has a deadline, e.g. "Call Peter about the PRO Screen · due Thu".',
      ]
    : [
        `- Call ${tool} exactly once, with text set to everything after the "Text:" line, exactly as written, and captureId set to the given captureId. When the text contains a URL, also pass that URL as url.`,
        '- ids: the id the tool returned.',
        '- summary: what was kept, in a few words, e.g. "The Liquid Glass article".',
      ];
  return [
    `You file what the user typed into ${TARGET_NAMES[target]}, and nothing else.`,
    '',
    ...call,
    '- Do not change, shorten or translate the text.',
    '- When the tool fails, answer with ids [] and summary "".',
    '',
    ...ANSWER_LINES,
  ].join('\n');
}

/** Every flag of a capture call, without the message, so a warm process can start on them. */
export function captureBootArgs(target: CaptureTarget, mcpConfigPath: string): string[] {
  return oneToolArgs(captureTool(target), mcpConfigPath, captureSystemPrompt(target));
}

/** The message for one capture: James's `captureId`, then the text. */
export function capturePrompt(target: CaptureTarget, text: string, captureId: string): string {
  return target === 'james' ? `captureId: ${captureId}\n\nText:\n${text}` : `Text:\n${text}`;
}

/** The `claude` argv for one cold capture call. */
export function captureArgs(target: CaptureTarget, text: string, captureId: string, mcpConfigPath: string): string[] {
  return [...captureBootArgs(target, mcpConfigPath), capturePrompt(target, text, captureId)];
}

/**
 * Turn a finished capture call into a receipt, or Patch's line for a failure.
 *
 * Nothing counts as stored without an id: a call that ran but came back with
 * none, or whose tool was refused, failed as far as the user is concerned.
 */
export function readCaptureRun(run: ClaudeRun, target: CaptureTarget): CaptureReceipt | { kind: 'failed'; reason: string } {
  const failed = { kind: 'failed' as const, reason: noAnswerLine(target) };
  const envelope = parseEnvelope(run.stdout);
  const message = envelope && typeof envelope.result === 'string' ? envelope.result : '';
  if (!envelope || envelope.is_error === true || run.exitCode !== 0) {
    const limit = usageLimitLine(message || run.stderr || run.stdout);
    return limit ? { kind: 'failed', reason: limit } : failed;
  }
  if (Array.isArray(envelope.permission_denials) && envelope.permission_denials.length > 0) return failed;

  const answer = parseAnswerObject(message);
  if (!answer || !Array.isArray(answer.ids)) return failed;
  const ids = answer.ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  if (ids.length === 0 || ids.length !== answer.ids.length) return failed;
  const summary = typeof answer.summary === 'string' ? oneLine(answer.summary) : '';
  return { target, ids, summary };
}

/** Patch's line when a capture didn't go through. */
export function noAnswerLine(target: CaptureTarget): string {
  return `${TARGET_NAMES[target]} didn’t answer. Try again?`;
}

// ── Undoing ──

/**
 * Who Haiku is for an undo. BlaakTasks takes every id in one call; James takes
 * one id per call, so it gets one call per id.
 */
export function undoSystemPrompt(target: CaptureTarget): string {
  const tool = undoTool(target);
  const call = target === 'tasks'
    ? `- Call ${tool} exactly once, with ids set to every listed id.`
    : `- Call ${tool} once for each listed id, with id set to that id.`;
  return [
    `You take back what was just filed into ${TARGET_NAMES[target]}, and nothing else.`,
    '',
    call,
    '',
    'Answering:',
    '- Answer with only this JSON object, no prose, no code fence:',
    '  {"ok": true} when every call succeeded, otherwise {"ok": false}',
  ].join('\n');
}

/** Every flag of an undo call, without the message. */
export function undoBootArgs(target: CaptureTarget, mcpConfigPath: string): string[] {
  return oneToolArgs(undoTool(target), mcpConfigPath, undoSystemPrompt(target));
}

/** The message for one undo: the ids to take back. */
export function undoPrompt(ids: readonly string[]): string {
  return ['Ids:', ...ids.map(id => `- ${id}`)].join('\n');
}

/** The `claude` argv for one cold undo call. */
export function undoArgs(target: CaptureTarget, ids: readonly string[], mcpConfigPath: string): string[] {
  return [...undoBootArgs(target, mcpConfigPath), undoPrompt(ids)];
}

/** Whether an undo call went through: only an answer of `{"ok": true}` says so. */
export function readUndoRun(run: ClaudeRun): boolean {
  const envelope = parseEnvelope(run.stdout);
  if (!envelope || envelope.is_error === true || run.exitCode !== 0 || typeof envelope.result !== 'string') return false;
  if (Array.isArray(envelope.permission_denials) && envelope.permission_denials.length > 0) return false;
  return parseAnswerObject(envelope.result)?.ok === true;
}

// ── Helpers ──

/**
 * The flags of a call allowed exactly one MCP tool, from one server's config.
 *
 * Like the routing call, it skips the user's settings and skills for startup
 * time. `--strict-mcp-config` keeps every other server out.
 */
function oneToolArgs(tool: string, mcpConfigPath: string, systemPrompt: string): string[] {
  return [
    '-p',
    '--model', 'haiku',
    '--output-format', 'json',
    '--tools', '',
    '--allowedTools', tool,
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--no-session-persistence',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--system-prompt', systemPrompt,
  ];
}

/** The first line of `text`, trimmed and cut short. */
function oneLine(text: string): string {
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? '';
  return first.length > MAX_SUMMARY ? first.slice(0, MAX_SUMMARY - 1).trimEnd() + '…' : first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
