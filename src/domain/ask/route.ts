/**
 * The rules for asking Claude where a typed request belongs (#135).
 *
 * One `claude -p` call with Haiku does the routing: it gets the local projects
 * and what the user typed, and answers with a project and a tidied prompt in a
 * fixed JSON shape. Everything about that call that is a decision rather than
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

/** The shape Haiku has to answer in, enforced by the CLI's structured output. */
export const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    projectPath: { type: ['string', 'null'] },
    confident: { type: 'boolean' },
    candidates: { type: 'array', items: { type: 'string' }, maxItems: MAX_SUGGESTIONS },
    prompt: { type: 'string' },
  },
  required: ['projectPath', 'confident', 'candidates', 'prompt'],
  additionalProperties: false,
} as const;

/**
 * Who Haiku is for this call, replacing Claude Code's own system prompt.
 *
 * The rewrite rules are P1: the user's request, tidied, in their language —
 * not a plan. A model asked to "clarify" a task will happily add steps and
 * guess at the cause, and then the session starts out chasing the guess.
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
  'Rewriting the request into prompt:',
  '- One clear task statement, phrased as an instruction, in the same language the request was written in.',
  '- Leave out the mention of the project.',
  '- Add no steps, guessed causes or requirements that the request does not state.',
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
 * The `claude` argv for one routing call.
 *
 * Everything after `--no-session-persistence` is there for startup time, which
 * the user sits through: without the user's settings (hooks, plugins), MCP
 * servers and skills, a call carries ~4k tokens instead of ~200k and answers in
 * about 2 s instead of 8. Auth is unaffected — it is the CLI's own login, not
 * a setting. `--bare` would go further but never reads the subscription login.
 */
export function routeArgs(request: RouteRequest): string[] {
  return [
    '-p',
    '--model', 'haiku',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(ROUTE_SCHEMA),
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--system-prompt', ROUTE_SYSTEM_PROMPT,
    routePrompt(request),
  ];
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
  return routeResultFrom(structuredAnswer(envelope), request);
}

/**
 * The CLI's single-result envelope, from the last JSON line of stdout.
 *
 * The call goes through the user's interactive shell, whose profile may print
 * a greeting first, so the envelope is looked for rather than assumed.
 */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseJson(lines[i]);
    if (isRecord(parsed) && parsed.type === 'result') return parsed;
  }
  return null;
}

/** The answer itself: `structured_output`, or the same JSON as text in `result`. */
function structuredAnswer(envelope: Record<string, unknown>): unknown {
  if (envelope.structured_output !== undefined) return envelope.structured_output;
  return typeof envelope.result === 'string' ? parseJson(envelope.result) : undefined;
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

  const rewritten = typeof answer.prompt === 'string' ? answer.prompt.trim() : '';
  if (!rewritten) return { kind: 'failed', reason: GARBLED_LINE };
  const prompt = composeInitialPrompt(rewritten, request.text);

  if (projectPath && answer.confident === true) return { kind: 'confident', projectPath, prompt };
  return { kind: 'unsure', candidates: suggestions, prompt };
}

/**
 * The session's first prompt: the tidied task, with what the user actually
 * typed kept underneath (P2), so a rewrite that lost something can't lose it
 * for good.
 */
export function composeInitialPrompt(rewritten: string, original: string): string {
  return `${rewritten}\n\n(Original: "${original}")`;
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
