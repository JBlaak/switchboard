import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { QuestionService } from '../src/application/services/question-service';
import { QUESTION_HOOK_TOKEN_HEADER } from '../src/domain/questions/question';
import { QuestionHookServer } from '../src/infrastructure/http/question-hook-server';
import { fakePty, fakeRenderer, silentLog } from './support/fakes';

/**
 * The hook server against real sockets: it has to turn away strangers, hold a
 * genuine question open until the service answers it, and notice when the CLI
 * gives up on the request.
 */

async function harness() {
  const registry = new SessionRegistry();
  const renderer = fakeRenderer();
  const server = new QuestionHookServer({
    receiver: { receive: (...args) => service.receive(...args) },
    log: silentLog,
  });
  const service = new QuestionService({
    registry, renderer, endpoint: server, log: silentLog, clock: { now: () => 0 },
  });
  await server.start();

  registry.add('s1', new ActiveSession({
    pty: fakePty(),
    projectPath: '/repo',
    projectFolder: '-repo',
    knownTranscriptIds: new Set(),
    sessionSlug: null,
    isPlainTerminal: false,
    remote: null,
    openedAt: 0,
  }));

  return { server, service, renderer };
}

const hookBody = {
  session_id: 'claude-id',
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_use_id: 'tu-1',
  tool_input: {
    questions: [{
      question: 'Which database?',
      header: 'DB',
      options: [{ label: 'SQLite', description: 'small' }, { label: 'Postgres', description: 'big' }],
      multiSelect: false,
    }],
  },
};

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Resolves once `predicate` holds, polling briefly. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(predicate(), 'condition never became true');
}

test('the endpoint is only known once listening, and forgotten on stop', async () => {
  /* Given */
  const server = new QuestionHookServer({ receiver: { receive: () => ({ withdraw() {} }) }, log: silentLog });

  /* Then */
  assert.equal(server.url, null);

  /* When */
  await server.start();

  /* Then */
  assert.match(server.url ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(server.token.length, 64);

  /* When */
  server.stop();

  /* Then */
  assert.equal(server.url, null);
});

test('a request without a token is refused', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());

  /* When */
  const res = await post(`${h.server.url}/ask/s1`, JSON.stringify(hookBody));

  /* Then */
  assert.equal(res.status, 401);
  assert.deepEqual(h.renderer.events, []);
});

test('a request with the wrong token is refused', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());

  /* When */
  const wrong = await post(`${h.server.url}/ask/s1`, JSON.stringify(hookBody), { [QUESTION_HOOK_TOKEN_HEADER]: 'nope' });

  /* Then */
  assert.equal(wrong.status, 401);
  assert.deepEqual(h.renderer.events, []);
});

test('other paths and methods are not found', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());
  const auth = { [QUESTION_HOOK_TOKEN_HEADER]: h.server.token };

  /* When */
  const other = await post(`${h.server.url}/other`, '{}', auth);
  const noSession = await post(`${h.server.url}/ask/`, '{}', auth);
  const get = await fetch(`${h.server.url}/ask/s1`, { headers: auth });

  /* Then */
  assert.equal(other.status, 404);
  assert.equal(noSession.status, 404);
  assert.equal(get.status, 404);
});

test('junk gets an empty decision', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());
  // Header names are case-insensitive.
  const auth = { [QUESTION_HOOK_TOKEN_HEADER.toLowerCase()]: h.server.token };

  /* When */
  const junk = await post(`${h.server.url}/ask/s1`, 'not json', auth);

  /* Then */
  assert.equal(junk.status, 200);
  assert.deepEqual(await junk.json(), {});
  assert.deepEqual(h.renderer.events, []);
});

test('other tools get an empty decision', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());
  // Header names are case-insensitive.
  const auth = { [QUESTION_HOOK_TOKEN_HEADER.toLowerCase()]: h.server.token };

  /* When */
  const bash = await post(`${h.server.url}/ask/s1`, JSON.stringify({ ...hookBody, tool_name: 'Bash' }), auth);

  /* Then */
  assert.deepEqual(await bash.json(), {});
  assert.deepEqual(h.renderer.events, []);
});

test('an oversized body is rejected', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());

  /* When */
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(`${h.server.url}/ask/s1`, {
      method: 'POST',
      headers: { [QUESTION_HOOK_TOKEN_HEADER]: h.server.token },
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(Buffer.alloc(1024 * 1024 + 1, 'x'));
  });

  /* Then */
  assert.equal(status, 413);
});

test('a question is held until it is answered in Switchboard', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());

  /* When */
  const response = post(`${h.server.url}/ask/s1`, JSON.stringify(hookBody), { [QUESTION_HOOK_TOKEN_HEADER]: h.server.token });

  /* Then */
  await until(() => h.service.pending().length === 1);
  assert.equal(h.renderer.only('questionsAsked').length, 1);

  /* When */
  const answered = h.service.answer('s1', 'tu-1', { 'Which database?': 'SQLite' });

  /* Then */
  assert.deepEqual(answered, { ok: true });
  const res = await response;
  assert.equal(res.status, 200);
  const json = await res.json() as { hookSpecificOutput: { permissionDecision: string; updatedInput: { answers: unknown } } };
  assert.equal(json.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(json.hookSpecificOutput.updatedInput.answers, { 'Which database?': 'SQLite' });
  assert.deepEqual(h.renderer.only('questionsSettled').map(e => (e[1] as { outcome: string }).outcome), ['answered']);
});

test('a question for an unknown session gets an empty decision', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());

  /* When */
  const res = await post(`${h.server.url}/ask/ghost`, JSON.stringify(hookBody), { [QUESTION_HOOK_TOKEN_HEADER]: h.server.token });

  /* Then */
  assert.deepEqual(await res.json(), {});
});

test('the CLI dropping the request withdraws the question', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.server.stop());
  const response = post(`${h.server.url}/ask/s1`, JSON.stringify(hookBody), {
    [QUESTION_HOOK_TOKEN_HEADER]: h.server.token,
  }).catch(() => null);
  await until(() => h.service.pending().length === 1);

  /* When */
  // A second set for the same session, then dropped from the client side as
  // the CLI does when its hook times out.
  const req = http.request(`${h.server.url}/ask/s1`, {
    method: 'POST',
    headers: { [QUESTION_HOOK_TOKEN_HEADER]: h.server.token },
  });
  req.on('error', () => {});
  req.end(JSON.stringify({ ...hookBody, tool_use_id: 'tu-2' }));

  /* Then */
  await until(() => h.service.pending()[0]?.toolUseId === 'tu-2');
  // The replacement released the first request with no decision.
  assert.deepEqual(await (await response)?.json(), {});

  /* When */
  req.destroy();

  /* Then */
  await until(() => h.service.pending().length === 0);
  const outcomes = h.renderer.only('questionsSettled').map(e => (e[1] as { toolUseId: string; outcome: string }));
  assert.deepEqual(outcomes, [
    { sessionId: 's1', toolUseId: 'tu-1', outcome: 'withdrawn' },
    { sessionId: 's1', toolUseId: 'tu-2', outcome: 'withdrawn' },
  ]);
});
