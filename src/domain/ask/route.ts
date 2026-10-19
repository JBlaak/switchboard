/**
 * The rules for asking Claude where a typed request belongs (#135).
 *
 * One `claude -p` call with Haiku does the routing: it gets the local projects
 * and what the user typed, and answers with a project and the session's first
 * prompt in a fixed JSON shape. Everything about that call that is a decision rather than
 * plumbing lives here: which projects are offered, the command line, the
 * instructions, and how far the answer is trusted. The answer is only ever a
 * suggestion — a path that isn't one of the candidates is treated as unknown,
 * however confident Haiku says it is.
 */
import type { Project } from '../project/project';
import type { SessionRow } from '../session/session';
import { cleanDisplayName, resolveSessionName } from '../session/title';
import { formatResetTime } from '../usage/usage';
import type { RouteCandidate, RouteRequest, RouteResult } from './model';

/** How many session titles describe a project to Haiku. */
export const RECENT_TITLES = 5;
/** How many candidates an unsure answer offers. */
export const MAX_SUGGESTIONS = 3;

const WORKTREE_PATH = /\/\.claude\/worktrees\//;

// ── Candidates ──

/**
 * The projects Haiku may route to: local ones only (R2).
 *
 * Remote projects can't start with a prompt yet, and a worktree is a copy of a
 * project that is already on the list — offering both would split the vote.
 */
export function routeCandidates(projects: Project[]): RouteCandidate[] {
  return projects
    .filter(project => !project.remote && !WORKTREE_PATH.test(project.projectPath))
    .map(project => ({
      projectPath: project.projectPath,
      folder: project.folder,
      recentTitles: recentTitles(project.sessions),
    }));
}

/** The names of a project's latest Claude sessions, newest first, as the list shows them. */
function recentTitles(sessions: SessionRow[]): string[] {
  return sessions
    .filter(row => !row.type || row.type === 'claude')
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .map(row => cleanDisplayName(resolveSessionName({ storedName: row.name, aiTitle: row.aiTitle }) || row.summary) ?? '')
    .filter(title => title !== '')
    .slice(0, RECENT_TITLES);
}

// ── The call ──

/**
 * Who Haiku is for this call, replacing Claude Code's own system prompt.
 *
 * The user talks to Patch ("let's fix X in Y"); the session needs a request
 * addressed to Claude. So the rewrite is a full request — the goal and what
 * done looks like for that kind of task (P1) — but never a guess: a model
 * asked to flesh out a task will happily name files and causes it can't see,
 * and then the session starts out chasing the guess.
 */
export const ROUTE_SYSTEM_PROMPT = [
  'You route a developer\'s request to one of their local projects and tidy the request into the first message of a coding session in that project.',
  '',
  'Choosing the project:',
  '- Pick from the listed projects only, and answer with its path exactly as listed.',
  '- Match on the project\'s name first, then on what its recent sessions were about.',
  '- Set confident to true only when the request clearly names or points at one project.',
  '- candidates: up to 3 listed paths that could be meant, best first.',
  '- When nothing fits, projectPath is null and candidates is empty.',
  '',
  'Writing prompt, the first message of the coding session:',
  '- The request is spoken to an assistant who hands it on ("let\'s fix X in Y", "ask Y to …"). Turn it into a request addressed directly to Claude, the coding agent working inside that project.',
  '- Write one to three complete sentences: state the goal plainly, and say what done looks like for that kind of task (e.g. applied everywhere it is used, verified, a short summary of what changed).',
  '- Keep everything the request asks for. A question stays a question.',
  '- Do not name files, components, causes or requirements the request does not mention; you cannot see the code.',
  '- Leave out the mention of the project.',
  '- Write in the same language the request was written in.',
  '',
  'Answering:',
  '- Answer with only this JSON object, no prose, no code fence:',
  '  {"projectPath": "<a listed path>" or null, "confident": true or false, "candidates": ["<a listed path>", ...], "prompt": "<the first message>"}',
].join('\n');

/** The message Haiku answers: the projects, then the request. */
export function routePrompt(request: RouteRequest): string {
  const projects = request.candidates.map(candidate => {
    const lines = [`- path: ${candidate.projectPath}`, `  folder: ${folderName(candidate.projectPath)}`];
    if (candidate.recentTitles.length > 0) {
      lines.push('  recent sessions:');
      for (const title of candidate.recentTitles) lines.push(`    - ${title}`);
    }
    return lines.join('\n');
  });
  return [
    'Projects:',
    projects.length > 0 ? projects.join('\n') : '(none)',
    '',
    'Request:',
    request.text,
  ].join('\n');
}

/**
 * The project's own folder name, which is what a user calls it.
 *
 * `RouteCandidate.folder` is the CLI's encoded transcript folder
 * (`-Users-me-code-app`), which no one types.
 */
function folderName(projectPath: string): string {
  return projectPath.replace(/\/+$/, '').split('/').pop() || projectPath;
}

/**
 * The `claude` argv for one routing call, all but the prompt and the output
 * format: what a process started ahead of the request boots with (S2).
 *
 * Everything after `--no-session-persistence` is there for startup time, which
 * the user sits through: without the user's settings (hooks, plugins), MCP
 * servers and skills, a call carries ~4k tokens instead of ~200k and answers in
 * about 2 s instead of 8. Auth is unaffected — it is the CLI's own login, not
 * a setting. `--bare` would go further but never reads the subscription login.
 *
 * There is no `--json-schema`: the CLI enforces a schema through a tool call,
 * which costs a second model turn (#143). The system prompt asks for bare JSON
 * instead, and `readAnswer` holds it to the same shape.
 */
export function routeBootArgs(): string[] {
  return [
    '-p',
    '--model', 'haiku',
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--system-prompt', ROUTE_SYSTEM_PROMPT,
  ];
}

/**
 * The `claude` argv for one cold routing call: the boot args, then the
 * prompt. The output format is the one thing added, since a warm process
 * answers in stream-json instead.
 */
export function routeArgs(request: RouteRequest): string[] {
  return [...routeBootArgs(), '--output-format', 'json', routePrompt(request)];
}

// ── The answer ──

/** How one `claude -p` call ended, as the process reported it. */
export interface ClaudeRun {
  /** null when the process was killed by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Patch's line when no project fits. */
export const NO_MATCH_LINE = 'Hmm, I couldn’t tell which project that’s for. Pick one?';
/** Patch's line when the answer came back in a shape that can't be read. */
export const GARBLED_LINE = 'I got a garbled answer back. Pick the project yourself?';

/**
 * Turn a finished routing call into a result.
 *
 * A failing CLI still prints its JSON envelope with `is_error` and a message
 * in `result`, and exits 1, so the envelope is read before the exit code: it
 * says more than the code does.
 */
export function readRouteRun(run: ClaudeRun, request: RouteRequest): RouteResult {
  const envelope = parseEnvelope(run.stdout);
  if (!envelope) {
    if (run.exitCode !== 0) return { kind: 'failed', reason: failureLine(run.stderr || run.stdout, run.exitCode) };
    return { kind: 'failed', reason: GARBLED_LINE };
  }
  const message = typeof envelope.result === 'string' ? envelope.result : '';
  if (envelope.is_error === true || run.exitCode !== 0) {
    return { kind: 'failed', reason: failureLine(message || run.stderr, run.exitCode) };
  }
  const answer = readAnswer(message, request);
  if (!answer) return { kind: 'failed', reason: GARBLED_LINE };
  return routeResultFrom(answer, request);
}

/**
 * The CLI's single-result envelope, from the last JSON line of stdout.
 *
 * The call goes through the user's interactive shell, whose profile may print
 * a greeting first, so the envelope is looked for rather than assumed.
 */
export function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseJson(lines[i]);
    if (isRecord(parsed) && parsed.type === 'result') return parsed;
  }
  return null;
}

/** What Haiku answers with, once `readAnswer` has checked it. */
export interface RouteAnswer {
  projectPath: string | null;
  confident: boolean;
  candidates: string[];
  prompt: string;
}

/** A ```` ```json ```` fence around the whole answer, which Haiku sometimes adds anyway. */
const FENCE = /^```(?:json)?[ \t]*\n?([\s\S]*?)\n?[ \t]*```$/;

/**
 * The answer as Haiku wrote it in `result`: the agreed JSON object and nothing
 * else, or null.
 *
 * This holds it to the shape `--json-schema` used to enforce — the four keys
 * with their types, at most three candidates — and to listed paths only: an
 * answer naming a project it was never shown didn't follow the instructions
 * either. A fence and whitespace around the object are fine; prose is not.
 */
export function readAnswer(text: string, request: RouteRequest): RouteAnswer | null {
  const trimmed = text.trim();
  const parsed = parseJson(trimmed.match(FENCE)?.[1] ?? trimmed);
  if (!isRecord(parsed)) return null;
  if (Object.keys(parsed).sort().join(',') !== 'candidates,confident,projectPath,prompt') return null;

  const known = new Set(request.candidates.map(candidate => candidate.projectPath));
  const listed = (path: unknown): path is string => typeof path === 'string' && known.has(path);
  const { projectPath, confident, candidates, prompt } = parsed;
  if (projectPath !== null && !listed(projectPath)) return null;
  if (typeof confident !== 'boolean' || typeof prompt !== 'string') return null;
  if (!Array.isArray(candidates) || candidates.length > MAX_SUGGESTIONS || !candidates.every(listed)) return null;

  return { projectPath, confident, candidates, prompt };
}

/**
 * Check Haiku's answer against the candidates it was given (R4).
 *
 * A path that isn't a candidate is dropped as though it was never said, so an
 * invented project can never be launched into.
 */
export function routeResultFrom(answer: unknown, request: RouteRequest): RouteResult {
  if (!isRecord(answer)) return { kind: 'failed', reason: GARBLED_LINE };

  const known = new Set(request.candidates.map(candidate => candidate.projectPath));
  const valid = (path: unknown): path is string => typeof path === 'string' && known.has(path);
  const projectPath = valid(answer.projectPath) ? answer.projectPath : null;
  const suggested = Array.isArray(answer.candidates) ? answer.candidates.filter(valid) : [];
  const suggestions = [...new Set(projectPath ? [projectPath, ...suggested] : suggested)].slice(0, MAX_SUGGESTIONS);

  if (suggestions.length === 0) return { kind: 'noMatch', reason: NO_MATCH_LINE };

  const prompt = typeof answer.prompt === 'string' ? answer.prompt.trim() : '';
  if (!prompt) return { kind: 'failed', reason: GARBLED_LINE };

  if (projectPath && answer.confident === true) return { kind: 'confident', projectPath, prompt };
  return { kind: 'unsure', candidates: suggestions, prompt };
}

// ── Failure lines ──

/** Longest a CLI message may run before Patch cuts it short. */
const MAX_REASON = 140;

/**
 * Patch's line for a call that failed: the usage limit gets its own, since it
 * is the one failure the user can't fix by trying again; anything else says
 * what the CLI said, trimmed to a line.
 */
export function failureLine(message: string, exitCode: number | null): string {
  const limit = usageLimitLine(message);
  if (limit) return limit;
  const first = message.split('\n').map(line => line.trim()).find(line => line !== '') ?? '';
  if (!first) return `Claude stopped without an answer (exit ${exitCode ?? 'signal'}).`;
  const cut = first.length > MAX_REASON ? first.slice(0, MAX_REASON - 1).trimEnd() + '…' : first;
  return `Claude couldn’t answer: ${cut}`;
}

/**
 * "You've hit your usage limit", with the reset time when the message gives one.
 *
 * The CLI has said this two ways: a sentence ("You've hit your limit · resets
 * 3pm (Europe/Amsterdam)") and, older, a marker with an epoch
 * ("Claude AI usage limit reached|1760000000"). Returns null for anything else.
 */
export function usageLimitLine(message: string): string | null {
  if (!/usage limit|hit your (?:[\w-]+ )?limit|limit reached/i.test(message)) return null;

  const epoch = message.match(/limit reached\|(\d{9,13})/i);
  const reset = epoch
    ? formatResetTime(Number(epoch[1]))
    : message.match(/resets?\s+(?:at\s+)?([^\n·•|]+?)\s*\.?\s*$/im)?.[1] ?? null;

  return reset ? `You’ve hit your usage limit — resets ${reset}.` : 'You’ve hit your usage limit.';
}

// ── Helpers ──

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
