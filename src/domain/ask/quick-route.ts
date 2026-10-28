/**
 * The routing call behind Quick Ask (#142, C1).
 *
 * The same call as Ask Patch's (route.ts), with one more question: is this a
 * coding session, a task for BlaakTasks or something to keep in James? Only an
 * explicit ask counts as a capture. Anything doubtful is read as a session, so
 * the worst a wrong guess does is start a session the user can close; it never
 * files their words somewhere they didn't ask for.
 *
 * The empty-screen box keeps `routeArgs` and `readRouteRun` unchanged.
 */
import type { CaptureTarget, QuickRouteResult, RouteRequest } from './model';
import { startsOnSharedSkill } from './skills';
import {
  GARBLED_LINE, ROUTE_SYSTEM_PROMPT, parseEnvelope, readAnswer, readRouteRun, routePrompt, routeResultFrom,
} from './route';
import type { ClaudeRun } from './route';

/** Where each capture kind goes. */
const CAPTURE_KINDS: Record<string, CaptureTarget> = { task: 'tasks', save: 'james' };

/** Every capture target, the default when the caller doesn't narrow them. */
const ALL_TARGETS: readonly CaptureTarget[] = Object.values(CAPTURE_KINDS);

/**
 * Ask Patch's instructions, plus the kind of request and, for a capture, its
 * text. The answer is the routing object with two more keys.
 *
 * Without the `tasks` target (BlaakTasks off, #252) there is no "task" kind:
 * a reminder reads as a session, and the instructions don't mention tasks.
 */
export function quickRouteSystemPrompt(targets: readonly CaptureTarget[] = ALL_TARGETS): string {
  const tasks = targets.includes('tasks');
  const captures = tasks ? '"task" or "save"' : '"save"';
  return [
    // Its own "Answering" section gives way to this call's, which adds two keys.
    ROUTE_SYSTEM_PROMPT.replace(/\n+Answering:[\s\S]*$/, ''),
    '',
    'Choosing kind:',
    ...(tasks
      ? ['- "task" when the request explicitly asks for a task or a reminder: "create a task", "add a task", "remind me to", "todo".']
      : []),
    '- "save" when it explicitly asks to save, keep or bookmark something, or is only a URL.',
    '- "session" for everything else. When in doubt, answer "session".',
    tasks
      ? '- For "task" or "save", captureText is the request without its command words ("create a task to call Peter" becomes "call Peter"), otherwise word for word. Keep URLs, dates and names exactly as written.'
      : '- For "save", captureText is the request without its command words ("save this https://example.com/a" becomes "https://example.com/a"), otherwise word for word. Keep URLs, dates and names exactly as written.',
    '- For "session", captureText is "".',
    `- For ${captures}, still fill the other keys: projectPath null, confident false, candidates [], prompt "".`,
    '',
    'Skills:',
    '- The listed skills are the slash commands of the coding session, by name. "Skills in every project" works anywhere; a project\'s own skills only in that project.',
    '- A skill\'s name or its own words in the request ("grill me" for grill-me, "tdd" for tdd) are a reference to that skill. Never reword them into a description of what the skill does.',
    '- When the request asks to run a skill ("grill me on X", "use tdd for X", "/review-pr 12"), prompt is "/" and the skill\'s name exactly as listed, a space, then the rest of the request word for word, without the words that named the skill and without the project. A request that is only the skill is only "/" and its name.',
    '- When the request only mentions a skill along the way, rewrite it as usual and keep the skill\'s name in it as written.',
    `- Only use a skill listed for every project or for the chosen project. A skill request is a "session", never a ${captures}.`,
    '',
    'Answering:',
    '- Answer with only this JSON object, no prose, no code fence:',
    `  {"kind": "session" or ${captures}, "captureText": "<the text to capture>" or "", "projectPath": "<a listed path>" or null, "confident": true or false, "candidates": ["<a listed path>", ...], "prompt": "<the first message>"}`,
  ].join('\n');
}

/** The instructions with every capture target offered. */
export const QUICK_ROUTE_SYSTEM_PROMPT = quickRouteSystemPrompt();

/** The two extra keys of a quick answer. */
const QUICK_KEYS = ['kind', 'captureText'];

/**
 * Every flag of the quick routing call, without the message, so a warm
 * process (#147) can start on them before the user presses Enter.
 *
 * The same flags as `routeArgs`, for the same reasons, with this call's
 * instructions.
 */
export function quickRouteBootArgs(targets: readonly CaptureTarget[] = ALL_TARGETS): string[] {
  return [
    '-p',
    '--model', 'haiku',
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--system-prompt', quickRouteSystemPrompt(targets),
  ];
}

/** The message Haiku answers: the projects, the skills, then the request, as for Ask Patch. */
export function quickRoutePrompt(request: RouteRequest): string {
  return routePrompt(request);
}

/** The `claude` argv for one cold quick routing call. */
export function quickRouteArgs(request: RouteRequest, targets: readonly CaptureTarget[] = ALL_TARGETS): string[] {
  return [...quickRouteBootArgs(targets), quickRoutePrompt(request)];
}

/**
 * Turn a finished quick routing call into a result.
 *
 * `task` or `save` with some text to capture is a capture. Everything else —
 * `session`, a kind it doesn't know, a capture with no text, a failed call —
 * reads exactly as `readRouteRun` reads it, the two extra keys aside, except
 * that no project keeps a prompt that starts on a skill every project has.
 * A capture for a target not in `targets` isn't one: its routing keys are read
 * as for a session.
 */
export function readQuickRouteRun(
  run: ClaudeRun, request: RouteRequest, targets: readonly CaptureTarget[] = ALL_TARGETS,
): QuickRouteResult {
  const envelope = parseEnvelope(run.stdout);
  if (!envelope || envelope.is_error === true || run.exitCode !== 0 || typeof envelope.result !== 'string') {
    return readRouteRun(run, request);
  }

  const answer = parseAnswerObject(envelope.result);
  if (!answer) return { kind: 'failed', reason: GARBLED_LINE };

  const target = typeof answer.kind === 'string' ? CAPTURE_KINDS[answer.kind] : undefined;
  const text = typeof answer.captureText === 'string' ? answer.captureText.trim() : '';
  if (target && targets.includes(target) && text) return { kind: 'capture', target, text };

  const routing = Object.fromEntries(Object.entries(answer).filter(([key]) => !QUICK_KEYS.includes(key)));
  const checked = readAnswer(JSON.stringify(routing), request);
  if (!checked) return { kind: 'failed', reason: GARBLED_LINE };
  const result = routeResultFrom(checked, request);
  // "Grill me" fits every project, so Haiku names none; the command still holds.
  if (result.kind === 'noMatch' && startsOnSharedSkill(checked.prompt, request.skills)) {
    return { ...result, prompt: checked.prompt.trim() };
  }
  return result;
}

/** A ```` ```json ```` fence around the whole answer, as `readAnswer` allows. */
const FENCE = /^```(?:json)?[ \t]*\n?([\s\S]*?)\n?[ \t]*```$/;

/** The JSON object Haiku wrote, fence and whitespace aside, or null. Shared with capture.ts. */
export function parseAnswerObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed.match(FENCE)?.[1] ?? trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
