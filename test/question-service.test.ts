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
  const logged: string[] = [];
  const log = { ...silentLog, info: (message: string) => { logged.push(message); } };
  const service = new QuestionService({
    registry, renderer, endpoint, log, clock: { now: () => now },
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

  return { registry, renderer, service, addSession, replies, logged, setNow: (t: number) => { now = t; } };
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
  /* Given */
  const h = harness();
  h.addSession('s1');
  const r = h.replies();

  /* When */
  h.service.receive('s1', asked(), r.reply);

  /* Then */
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

test('the log names the tool-use id of each set asked and settled', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');

  /* When */
  h.service.receive('s1', asked('tu-1'), h.replies().reply);
  h.service.receive('s1', asked(''), h.replies().reply);

  /* Then */
  assert.deepEqual(h.logged, [
    '[questions] session=s1 tool=tu-1 asked 1 question(s)',
    '[questions] session=s1 tool=tu-1 withdrawn',
    '[questions] session=s1 tool=(none) asked 1 question(s)',
  ]);
});

test('a question for an unknown session is left to the terminal', () => {
  /* Given */
  const h = harness();
  const r = h.replies();

  /* When */
  const handle = h.service.receive('nobody', asked(), r.reply);

  /* Then */
  assert.deepEqual(r.calls, [{}]);
  assert.deepEqual(h.renderer.events, []);
  assert.deepEqual(h.service.pending(), []);

  /* When */
  handle.withdraw();

  /* Then */
  assert.deepEqual(h.renderer.events, []);
});

test('answering replies with the tool input plus answers and settles it', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  h.service.receive('s1', asked(), r.reply);

  /* When */
  const result = h.service.answer('s1', 'tu-1', { 'Which database?': 'SQLite' });

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(r.calls, [questionHookResponse(asked().toolInput, { 'Which database?': 'SQLite' })]);
  assert.deepEqual(h.renderer.only('questionsSettled'), [
    ['questionsSettled', { sessionId: 's1', toolUseId: 'tu-1', outcome: 'answered' }],
  ]);
  assert.deepEqual(h.service.pending(), []);
});

test('the request closing after the reply is not a withdrawal', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  const handle = h.service.receive('s1', asked(), r.reply);
  h.service.answer('s1', 'tu-1', { 'Which database?': 'SQLite' });

  /* When */
  handle.withdraw();

  /* Then */
  assert.equal(h.renderer.only('questionsSettled').length, 1);
});

test('answering with the wrong tool use id fails', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  h.service.receive('s1', asked(), r.reply);

  /* When */
  const wrong = h.service.answer('s1', 'tu-other', {});

  /* Then */
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'These questions are no longer waiting');
  assert.deepEqual(r.calls, []);
});

test('answering twice fails, replying only once', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  h.service.receive('s1', asked(), r.reply);

  /* When */
  const first = h.service.answer('s1', 'tu-1', {});
  const second = h.service.answer('s1', 'tu-1', {});

  /* Then */
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(r.calls.length, 1);
});

test('answering for an unknown session fails', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  h.service.receive('s1', asked(), r.reply);

  /* When */
  const result = h.service.answer('ghost', 'tu-1', {});

  /* Then */
  assert.equal(result.ok, false);
  assert.deepEqual(r.calls, []);
});

test('the request going away withdraws it once', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  const handle = h.service.receive('s1', asked(), r.reply);

  /* When */
  handle.withdraw();
  handle.withdraw();

  /* Then */
  assert.deepEqual(h.renderer.only('questionsSettled'), [
    ['questionsSettled', { sessionId: 's1', toolUseId: 'tu-1', outcome: 'withdrawn' }],
  ]);
  assert.deepEqual(h.service.pending(), []);
  assert.deepEqual(r.calls, []);
});

test('a withdrawn set can no longer be answered', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const r = h.replies();
  h.service.receive('s1', asked(), r.reply).withdraw();

  /* When */
  const result = h.service.answer('s1', 'tu-1', {});

  /* Then */
  assert.equal(result.ok, false);
  assert.deepEqual(r.calls, []);
});

test('a new set for the same session releases and withdraws the old one', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const first = h.replies();
  const second = h.replies();
  h.service.receive('s1', asked('tu-1'), first.reply);

  /* When */
  h.service.receive('s1', asked('tu-2'), second.reply);

  /* Then */
  assert.deepEqual(first.calls, [{}]);
  assert.deepEqual(h.renderer.only('questionsSettled'), [
    ['questionsSettled', { sessionId: 's1', toolUseId: 'tu-1', outcome: 'withdrawn' }],
  ]);
  assert.deepEqual(h.service.pending().map(p => p.toolUseId), ['tu-2']);
});

test('the old request closing late does not take the new set with it', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const firstHandle = h.service.receive('s1', asked('tu-1'), h.replies().reply);
  h.service.receive('s1', asked('tu-2'), h.replies().reply);

  /* When */
  firstHandle.withdraw();

  /* Then */
  assert.deepEqual(h.service.pending().map(p => p.toolUseId), ['tu-2']);
  assert.equal(h.renderer.only('questionsSettled').length, 1);
});

/** A session asked under 'temp' that has since been re-keyed to 'real'. */
function rekeyed() {
  const h = harness();
  h.addSession('temp');
  h.service.receive('temp', asked('tu-1'), h.replies().reply);
  h.registry.rekey('temp', 'real');
  return h;
}

test('a re-keyed session is reported under its new id', () => {
  /* Given */
  const h = harness();
  h.addSession('temp');
  h.service.receive('temp', asked('tu-1'), h.replies().reply);

  /* When */
  h.registry.rekey('temp', 'real');

  /* Then */
  assert.equal(h.service.pending()[0].sessionId, 'real');
});

test('a set asked under the launch id after a re-key is reported under the new id', () => {
  /* Given */
  const h = rekeyed();

  /* When */
  // The hook URL still carries the launch id; it finds the same session.
  h.service.receive('temp', asked('tu-2'), h.replies().reply);

  /* Then */
  assert.equal((h.renderer.only('questionsAsked')[1][1] as { sessionId: string }).sessionId, 'real');
  assert.deepEqual(h.renderer.only('questionsSettled')[0][1], { sessionId: 'real', toolUseId: 'tu-1', outcome: 'withdrawn' });
});

test('a re-keyed session is answerable under its launch id', () => {
  /* Given */
  const h = rekeyed();
  const again = h.replies();
  h.service.receive('temp', asked('tu-2'), again.reply);

  /* When */
  const result = h.service.answer('temp', 'tu-2', { q: 'a' });

  /* Then */
  assert.equal(result.ok, true);
  assert.equal(again.calls.length, 1);
});

test('the hook settings name the session in the URL and carry the token', () => {
  /* Given */
  const h = harness({ url: 'http://127.0.0.1:4000', token: 'secret' });

  /* When */
  const settings = JSON.parse(h.service.settingsFor('a b/c') ?? 'null');

  /* Then */
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  assert.equal(hook.url, 'http://127.0.0.1:4000/ask/a%20b%2Fc');
  assert.equal(hook.headers['X-Switchboard-Token'], 'secret');
});

test('no hook settings while the server is not listening', () => {
  /* Given */
  const h = harness({ url: null, token: 'secret' });

  /* When */
  const settings = h.service.settingsFor('s1');

  /* Then */
  assert.equal(settings, null);
});
