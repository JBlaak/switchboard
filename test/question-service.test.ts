import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { QuestionService } from '../src/application/services/question-service';
import {
  QUESTION_HOOK_TIMEOUT_SECONDS, questionHookResponse,
} from '../src/domain/questions/question';
import { fakePty, fakeRenderer, silentLog } from './support/fakes';
import type { AskedQuestions } from '../src/domain/questions/question';
import type { QuestionHookEndpoint } from '../src/application/ports/question-hook';

/**
 * The bookkeeping between a held hook request and the renderer: every set
 * asked is either answered or withdrawn exactly once, and the renderer always
 * hears about it under the session's current id.
 */

function harness(endpoint: QuestionHookEndpoint = { url: 'http://127.0.0.1:4000', token: 'secret' }) {
  const registry = new SessionRegistry();
  const renderer = fakeRenderer();
  let now = 1_000;
  const service = new QuestionService({
    registry, renderer, endpoint, log: silentLog, clock: { now: () => now },
  });

  const addSession = (id: string): ActiveSession => {
    const session = new ActiveSession({
      pty: fakePty(),
      projectPath: '/repo',
      projectFolder: '-repo',
      knownTranscriptIds: new Set(),
      sessionSlug: null,
      isPlainTerminal: false,
      remote: null,
      openedAt: 0,
    });
    registry.add(id, session);
    return session;
  };

  /** A reply function that records what it was called with. */
  const replies = () => {
    const calls: Record<string, unknown>[] = [];
    return { calls, reply: (json: Record<string, unknown>) => { calls.push(json); } };
  };

  return { registry, renderer, service, addSession, replies, setNow: (t: number) => { now = t; } };
}

function asked(toolUseId = 'tu-1'): AskedQuestions {
  const toolInput = {
    questions: [{
      question: 'Which database?',
      header: 'DB',
      options: [{ label: 'SQLite' }, { label: 'Postgres' }],
      multiSelect: false,
    }],
  };
  return {
    toolUseId,
    toolInput,
    questions: [{
      question: 'Which database?',
      header: 'DB',
      options: [{ label: 'SQLite', description: '' }, { label: 'Postgres', description: '' }],
      multiSelect: false,
    }],
  };
}

test('a question for a running session is shown with its deadline', () => {
  const h = harness();
  h.addSession('s1');
  const r = h.replies();

  h.service.receive('s1', asked(), r.reply);

  assert.deepEqual(r.calls, []);
  const [[, pending]] = h.renderer.only('questionsAsked');
  assert.deepEqual(pending, {
    sessionId: 's1',
    toolUseId: 'tu-1',
    questions: asked().questions,
    askedAt: 1_000,
    deadline: 1_000 + QUESTION_HOOK_TIMEOUT_SECONDS * 1000,
  });
  assert.equal(h.service.pending().length, 1);
});

test('a question for an unknown session is left to the terminal', () => {
  const h = harness();
  const r = h.replies();

  const handle = h.service.receive('nobody', asked(), r.reply);
  handle.withdraw();

  assert.deepEqual(r.calls, [{}]);
  assert.deepEqual(h.renderer.events, []);
  assert.deepEqual(h.service.pending(), []);
});

test('answering replies with the tool input plus answers and settles it', () => {
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  const handle = h.service.receive('s1', asked(), r.reply);

  const result = h.service.answer('s1', 'tu-1', { 'Which database?': 'SQLite' });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(r.calls, [questionHookResponse(asked().toolInput, { 'Which database?': 'SQLite' })]);
  assert.deepEqual(h.renderer.only('questionsSettled'), [
    ['questionsSettled', { sessionId: 's1', toolUseId: 'tu-1', outcome: 'answered' }],
  ]);
  assert.deepEqual(h.service.pending(), []);

  // The request closing after the reply is not a withdrawal.
  handle.withdraw();
  assert.equal(h.renderer.only('questionsSettled').length, 1);
});

test('answering twice, or with the wrong tool use id, fails', () => {
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  h.service.receive('s1', asked(), r.reply);

  const wrong = h.service.answer('s1', 'tu-other', {});
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'These questions are no longer waiting');

  assert.equal(h.service.answer('s1', 'tu-1', {}).ok, true);
  assert.equal(h.service.answer('s1', 'tu-1', {}).ok, false);
  assert.equal(h.service.answer('ghost', 'tu-1', {}).ok, false);
  assert.equal(r.calls.length, 1);
});

test('the request going away withdraws it once', () => {
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  const handle = h.service.receive('s1', asked(), r.reply);

  handle.withdraw();
  handle.withdraw();

  assert.deepEqual(h.renderer.only('questionsSettled'), [
    ['questionsSettled', { sessionId: 's1', toolUseId: 'tu-1', outcome: 'withdrawn' }],
  ]);
  assert.deepEqual(h.service.pending(), []);
  assert.deepEqual(r.calls, []);
  assert.equal(h.service.answer('s1', 'tu-1', {}).ok, false);
});

test('a new set for the same session releases and withdraws the old one', () => {
  const h = harness();
  h.addSession('s1');
  const first = h.replies();
  const second = h.replies();
  const firstHandle = h.service.receive('s1', asked('tu-1'), first.reply);

  h.service.receive('s1', asked('tu-2'), second.reply);

  assert.deepEqual(first.calls, [{}]);
  assert.deepEqual(h.renderer.only('questionsSettled'), [
    ['questionsSettled', { sessionId: 's1', toolUseId: 'tu-1', outcome: 'withdrawn' }],
  ]);
  assert.deepEqual(h.service.pending().map(p => p.toolUseId), ['tu-2']);

  // The old request's late close must not take the new set with it.
  firstHandle.withdraw();
  assert.deepEqual(h.service.pending().map(p => p.toolUseId), ['tu-2']);
  assert.equal(h.renderer.only('questionsSettled').length, 1);
});

test('a re-keyed session is reported under its new id and answerable under any', () => {
  const h = harness();
  h.addSession('temp');
  const r = h.replies();
  h.service.receive('temp', asked('tu-1'), r.reply);

  h.registry.rekey('temp', 'real');
  assert.equal(h.service.pending()[0].sessionId, 'real');

  // The hook URL still carries the launch id; it finds the same session.
  const again = h.replies();
  h.service.receive('temp', asked('tu-2'), again.reply);
  assert.equal((h.renderer.only('questionsAsked')[1][1] as { sessionId: string }).sessionId, 'real');
  assert.deepEqual(h.renderer.only('questionsSettled')[0][1], { sessionId: 'real', toolUseId: 'tu-1', outcome: 'withdrawn' });

  assert.equal(h.service.answer('temp', 'tu-2', { q: 'a' }).ok, true);
  assert.equal(again.calls.length, 1);
});

test('the hook settings name the session in the URL and carry the token', () => {
  const h = harness({ url: 'http://127.0.0.1:4000', token: 'secret' });
  const settings = JSON.parse(h.service.settingsFor('a b/c') ?? 'null');
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  assert.equal(hook.url, 'http://127.0.0.1:4000/ask/a%20b%2Fc');
  assert.equal(hook.headers['X-Switchboard-Token'], 'secret');
});

test('no hook settings while the server is not listening', () => {
  const h = harness({ url: null, token: 'secret' });
  assert.equal(h.service.settingsFor('s1'), null);
});
