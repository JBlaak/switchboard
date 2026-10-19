import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GARBLED_LINE, NO_MATCH_LINE, ROUTE_SYSTEM_PROMPT,
  failureLine, readRouteRun, routeArgs, routeBootArgs, routeCandidates, routePrompt,
  routeResultFrom, usageLimitLine,
} from '../src/domain/ask/route';
import type { RouteRequest } from '../src/domain/ask/model';
import type { Project } from '../src/domain/project/project';
import type { SessionRow } from '../src/domain/session/session';

/**
 * Ask Patch's routing rules (#135): which projects Haiku may pick from, the
 * call that asks it, and how far its answer is trusted.
 */

const APP = '/code/app';
const SITE = '/code/site';
const TOOLS = '/code/tools';
const DOCS = '/code/docs';

function request(text = 'Fix the login bug in app', paths = [APP, SITE, TOOLS, DOCS]): RouteRequest {
  return {
    text,
    candidates: paths.map(projectPath => ({ projectPath, folder: projectPath.replace(/\//g, '-'), recentTitles: [] })),
  };
}

function row(summary: string, modified: string, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: summary, summary, firstPrompt: summary, projectPath: APP,
    created: modified, modified, messageCount: 1, name: null, starred: 0, archived: 0,
    ...extra,
  };
}

function project(projectPath: string, sessions: SessionRow[] = [], remote = false): Project {
  return { projectPath, folder: projectPath.replace(/\//g, '-'), sessions, ...(remote ? { remote } : {}) };
}

/** A real `claude -p --output-format json` answer, trimmed, with `result` as Haiku wrote it. */
function envelope(answer: unknown): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    num_turns: 1,
    result: typeof answer === 'string' ? answer : JSON.stringify(answer),
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
  });
}

function run(answer: unknown): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: envelope(answer) + '\n', stderr: '' };
}

// ── Candidates ──

test('routeCandidates offers local projects and leaves out remotes and worktrees', () => {
  /* Given */
  const projects = [
    project(APP),
    project('ssh://box/srv/app', [], true),
    project('/code/app/.claude/worktrees/fix-login'),
    project(SITE),
  ];

  /* When */
  const candidates = routeCandidates(projects);

  /* Then */
  assert.deepEqual(candidates.map(c => c.projectPath), [APP, SITE]);
  assert.equal(candidates[0].folder, '-code-app');
});

test('routeCandidates describes a project by its last five Claude sessions, newest first', () => {
  /* Given */
  const sessions = [
    row('one', '2026-10-01T00:00:00Z'),
    row('six', '2026-10-06T00:00:00Z'),
    row('three', '2026-10-03T00:00:00Z'),
    row('a shell', '2026-10-09T00:00:00Z', { type: 'terminal' }),
    row('remote', '2026-10-08T00:00:00Z', { type: 'remote' }),
    row('five', '2026-10-05T00:00:00Z'),
    row('two', '2026-10-02T00:00:00Z'),
    row('four', '2026-10-04T00:00:00Z', { type: 'claude' }),
  ];

  /* When */
  const [candidate] = routeCandidates([project(APP, sessions)]);

  /* Then */
  assert.deepEqual(candidate.recentTitles, ['six', 'five', 'four', 'three', 'two']);
});

test('routeCandidates names a session the way the list does: rename, then AI title, then first prompt', () => {
  /* Given */
  const sessions = [
    row('first prompt', '2026-10-03T00:00:00Z', { name: 'My rename', aiTitle: 'AI title' }),
    row('first prompt', '2026-10-02T00:00:00Z', { aiTitle: 'AI title' }),
    row('Implement the following plan: <b>Ship it</b>', '2026-10-01T00:00:00Z'),
  ];

  /* When */
  const [candidate] = routeCandidates([project(APP, sessions)]);

  /* Then */
  assert.deepEqual(candidate.recentTitles, ['My rename', 'AI title', 'Ship it']);
});

// ── The call ──

test('routeArgs asks Haiku for a JSON envelope with no tools and nothing persisted', () => {
  /* Given */
  const req = request();

  /* When */
  const args = routeArgs(req);

  /* Then */
  assert.equal(args[0], '-p');
  const flag = (name: string): string => args[args.indexOf(name) + 1];
  assert.equal(flag('--model'), 'haiku');
  assert.equal(flag('--output-format'), 'json');
  assert.equal(flag('--tools'), '');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args.at(-1), routePrompt(req));
});

test('routeArgs skips the user\'s settings, MCP servers and skills, for startup time', () => {
  /* Given */
  const req = request();

  /* When */
  const args = routeArgs(req);

  /* Then */
  const flag = (name: string): string => args[args.indexOf(name) + 1];
  assert.equal(flag('--setting-sources'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(flag('--mcp-config')), { mcpServers: {} });
  assert.ok(args.includes('--disable-slash-commands'));
  assert.equal(flag('--system-prompt'), ROUTE_SYSTEM_PROMPT);
});

test('routeArgs leaves out --json-schema, which costs a second model turn', () => {
  /* Given */
  const req = request();

  /* When */
  const args = routeArgs(req);

  /* Then */
  assert.ok(!args.includes('--json-schema'));
});

test('routeBootArgs is the cold call without its prompt and output format, for a warm process', () => {
  /* Given */
  const req = request();

  /* When */
  const boot = routeBootArgs();

  /* Then */
  assert.deepEqual(routeArgs(req), [...boot, '--output-format', 'json', routePrompt(req)]);
  assert.ok(!boot.includes('--output-format'));
  assert.ok(!boot.some(arg => arg.includes(req.text)));
});

test('the instructions name the JSON shape and ask for nothing around it', () => {
  /* Given */
  const instructions = ROUTE_SYSTEM_PROMPT;

  /* When */
  const shape = instructions.split('\n').find(line => line.includes('"projectPath"')) ?? '';

  /* Then */
  for (const key of ['projectPath', 'confident', 'candidates', 'prompt']) assert.ok(shape.includes(`"${key}"`), key);
  assert.match(instructions, /only this JSON object, no prose, no code fence/);
});

test('routePrompt lists every candidate\'s path, folder name and recent sessions, then the request', () => {
  /* Given */
  const req: RouteRequest = {
    text: 'Let\'s fix the timer in the scoreboard',
    candidates: [
      { projectPath: '/code/WedstrijdKlok.nl', folder: '-code-WedstrijdKlok-nl', recentTitles: ['Timer drift', 'Dark mode'] },
      { projectPath: SITE, folder: '-code-site', recentTitles: [] },
    ],
  };

  /* When */
  const prompt = routePrompt(req);

  /* Then */
  assert.match(prompt, /path: \/code\/WedstrijdKlok\.nl\n {2}folder: WedstrijdKlok\.nl\n {2}recent sessions:\n {4}- Timer drift\n {4}- Dark mode/);
  assert.match(prompt, /path: \/code\/site\n {2}folder: site/);
  assert.ok(prompt.endsWith('Request:\nLet\'s fix the timer in the scoreboard'));
});

test('the instructions ask for a full request to Claude, in the user\'s language, with nothing guessed', () => {
  /* Given */
  const instructions = ROUTE_SYSTEM_PROMPT;

  /* When */
  const lines = instructions.split('\n');

  /* Then */
  assert.ok(lines.some(line => /same language/.test(line)));
  assert.ok(lines.some(line => /Leave out the mention of the project/.test(line)));
  assert.ok(lines.some(line => /addressed directly to Claude/.test(line)));
  assert.ok(lines.some(line => /what done looks like/.test(line)));
  assert.ok(lines.some(line => /Do not name files, components, causes or requirements/.test(line)));
});

// ── The answer ──

test('a confident answer with a listed path starts there, with the original kept', () => {
  /* Given */
  const req = request('Let\'s fix the login bug in app');
  const answer = { projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login bug.' };

  /* When */
  const result = routeResultFrom(answer, req);

  /* Then */
  assert.deepEqual(result, {
    kind: 'confident',
    projectPath: APP,
    prompt: 'Fix the login bug.',
  });
});

test('an unconfident answer offers its pick first, then the other listed candidates', () => {
  /* Given */
  const req = request();
  const answer = { projectPath: SITE, confident: false, candidates: [APP, SITE, TOOLS], prompt: 'Fix the login bug.' };

  /* When */
  const result = routeResultFrom(answer, req);

  /* Then */
  assert.deepEqual(result, {
    kind: 'unsure',
    candidates: [SITE, APP, TOOLS],
    prompt: 'Fix the login bug.',
  });
});

test('a null path with listed candidates is unsure', () => {
  /* Given */
  const req = request();
  const answer = { projectPath: null, confident: false, candidates: [TOOLS, APP], prompt: 'Fix the login bug.' };

  /* When */
  const result = routeResultFrom(answer, req);

  /* Then */
  assert.equal(result.kind, 'unsure');
  assert.deepEqual(result.kind === 'unsure' && result.candidates, [TOOLS, APP]);
});

test('an unsure answer offers at most three candidates, best first', () => {
  /* Given */
  const req = request();
  const answer = { projectPath: null, confident: false, candidates: [DOCS, TOOLS, SITE, APP], prompt: 'Fix it.' };

  /* When */
  const result = routeResultFrom(answer, req);

  /* Then */
  assert.deepEqual(result.kind === 'unsure' && result.candidates, [DOCS, TOOLS, SITE]);
});

test('an invented path counts as unknown, however confident Haiku is', () => {
  /* Given */
  const req = request();
  const answer = { projectPath: '/code/elsewhere', confident: true, candidates: ['/code/elsewhere', SITE], prompt: 'Fix it.' };

  /* When */
  const result = routeResultFrom(answer, req);

  /* Then */
  assert.deepEqual(result, { kind: 'unsure', candidates: [SITE], prompt: 'Fix it.' });
});

test('an answer with no listed path is no match, in Patch\'s words', () => {
  /* Given */
  const req = request();
  const answers = [
    { projectPath: null, confident: false, candidates: [], prompt: 'Fix it.' },
    { projectPath: '/code/elsewhere', confident: true, candidates: ['/code/elsewhere'], prompt: 'Fix it.' },
  ];

  for (const answer of answers) {
    /* When */
    const result = routeResultFrom(answer, req);

    /* Then */
    assert.deepEqual(result, { kind: 'noMatch', reason: NO_MATCH_LINE });
  }
});

test('an answer that isn\'t the agreed shape fails', () => {
  /* Given */
  const req = request();
  const answers: unknown[] = [
    null, 'app', 42, [APP],
    { projectPath: APP, confident: true, candidates: [APP] },
    { projectPath: APP, confident: true, candidates: [APP], prompt: '   ' },
  ];

  for (const answer of answers) {
    /* When */
    const result = routeResultFrom(answer, req);

    /* Then */
    assert.deepEqual(result, { kind: 'failed', reason: GARBLED_LINE }, JSON.stringify(answer));
  }
});

// ── Reading the process's output ──

test('a successful run is read from the JSON in the envelope\'s result', () => {
  /* Given */
  const req = request();
  const stdout = envelope({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login bug.' }) + '\n';

  /* When */
  const result = readRouteRun({ exitCode: 0, stdout, stderr: '' }, req);

  /* Then */
  assert.equal(result.kind, 'confident');
});

test('a bare, a fenced and a padded answer all read the same', () => {
  /* Given */
  const req = request();
  const json = JSON.stringify({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login bug.' });
  const texts = [json, '```json\n' + json + '\n```', '```\n' + json + '\n```', '\n  ' + json + '  \n', '  ```json\n' + json + '\n```\n'];

  for (const text of texts) {
    /* When */
    const result = readRouteRun(run(text), req);

    /* Then */
    assert.deepEqual(result, { kind: 'confident', projectPath: APP, prompt: 'Fix the login bug.' }, text);
  }
});

test('an answer off the agreed shape, with prose around it, or naming an unlisted path is garbled', () => {
  /* Given */
  const req = request();
  const good = { projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login bug.' };
  const texts = [
    JSON.stringify({ ...good, confident: 'yes' }),
    JSON.stringify({ ...good, projectPath: 42 }),
    JSON.stringify({ ...good, candidates: APP }),
    JSON.stringify({ ...good, candidates: [APP, 7] }),
    JSON.stringify({ ...good, prompt: null }),
    JSON.stringify({ ...good, candidates: [APP, SITE, TOOLS, DOCS] }),
    JSON.stringify({ ...good, reason: 'It says app.' }),
    JSON.stringify({ projectPath: APP, confident: true, candidates: [APP] }),
    'Here is the routing: ' + JSON.stringify(good),
    JSON.stringify(good) + '\nHope that helps!',
    JSON.stringify({ ...good, projectPath: '/code/elsewhere' }),
    JSON.stringify({ ...good, candidates: [APP, '/code/elsewhere'] }),
    '[]',
    '',
  ];

  for (const text of texts) {
    /* When */
    const result = readRouteRun(run(text), req);

    /* Then */
    assert.deepEqual(result, { kind: 'failed', reason: GARBLED_LINE }, text);
  }
});

test('the envelope is found after whatever the shell profile printed first', () => {
  /* Given */
  const req = request();
  const answer = { projectPath: null, confident: false, candidates: [SITE], prompt: 'Fix it.' };
  const stdout = 'Welcome back!\n{not json\n' + envelope(answer) + '\n';

  /* When */
  const result = readRouteRun({ exitCode: 0, stdout, stderr: '' }, req);

  /* Then */
  assert.deepEqual(result.kind === 'unsure' && result.candidates, [SITE]);
});

test('output that holds no envelope fails as garbled', () => {
  /* Given */
  const req = request();
  const outputs = ['', 'Hi', '{"type":"result",', '{"answer":"Hi"}'];

  for (const stdout of outputs) {
    /* When */
    const result = readRouteRun({ exitCode: 0, stdout, stderr: '' }, req);

    /* Then */
    assert.deepEqual(result, { kind: 'failed', reason: GARBLED_LINE }, stdout);
  }
});

test('an error envelope fails with the CLI\'s own message', () => {
  /* Given */
  const req = request();
  // What the CLI printed, trimmed, for a model it doesn't know; it exits 1.
  const stdout = JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, api_error_status: 404, terminal_reason: 'api_error',
    result: 'There\'s an issue with the selected model (nonexistent-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.',
  });

  /* When */
  const result = readRouteRun({ exitCode: 1, stdout, stderr: '[claude-code:unrecognized_model] {}' }, req);

  /* Then */
  assert.equal(result.kind, 'failed');
  assert.match(result.kind === 'failed' ? result.reason : '', /^Claude couldn’t answer: There's an issue with the selected model/);
});

test('a non-zero exit without an envelope fails with what it said on stderr', () => {
  /* Given */
  const req = request();

  /* When */
  const result = readRouteRun({ exitCode: 127, stdout: '', stderr: 'zsh: command not found: claude\n' }, req);

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: 'Claude couldn’t answer: zsh: command not found: claude' });
});

test('a non-zero exit that said nothing still gives a reason', () => {
  /* Given */
  const req = request();

  /* When */
  const result = readRouteRun({ exitCode: 2, stdout: '', stderr: '' }, req);

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: 'Claude stopped without an answer (exit 2).' });
});

// ── Failure lines ──

test('the usage limit is named, with its reset time when the CLI gives one', () => {
  /* Given */
  const messages: [string, string][] = [
    ['You\'ve hit your limit · resets 3pm (Europe/Amsterdam)', 'You’ve hit your usage limit — resets 3pm (Europe/Amsterdam).'],
    ['5-hour limit reached ∙ resets 11am', 'You’ve hit your usage limit — resets 11am.'],
    ['Claude AI usage limit reached.', 'You’ve hit your usage limit.'],
  ];

  for (const [message, expected] of messages) {
    /* When */
    const line = failureLine(message, 1);

    /* Then */
    assert.equal(line, expected, message);
  }
});

test('the older usage-limit marker\'s epoch becomes a reset time', () => {
  /* Given */
  const message = 'Claude AI usage limit reached|1760000000';

  /* When */
  const line = usageLimitLine(message);

  /* Then */
  assert.match(line ?? '', /^You’ve hit your usage limit — resets .+\.$/);
});

test('any other message is not a usage limit', () => {
  /* Given */
  const message = 'API Error: 500 Internal server error';

  /* When */
  const line = usageLimitLine(message);

  /* Then */
  assert.equal(line, null);
});

test('a long CLI message is cut to one short line', () => {
  /* Given */
  const message = 'x'.repeat(400) + '\nsecond line';

  /* When */
  const line = failureLine(message, 1);

  /* Then */
  assert.ok(line.length < 180);
  assert.ok(line.endsWith('…'));
  assert.ok(!line.includes('second line'));
});
