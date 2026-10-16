import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuestionHookInput, questionHookResponse, questionHookSettings,
  QUESTION_HOOK_STATUS, QUESTION_HOOK_TIMEOUT_SECONDS, QUESTION_HOOK_TOKEN_HEADER,
} from '../src/domain/questions/question';

function body(over: Record<string, unknown> = {}, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_1',
    tool_input: {
      questions: [{
        question: 'Which timeout?',
        header: 'Timeout',
        options: [{ label: 'Short', description: '30s' }, { label: 'Long (Recommended)', description: '5m' }],
        multiSelect: false,
      }],
      ...input,
    },
    ...over,
  };
}

test('a well-formed AskUserQuestion call parses, keeping the tool input as received', () => {
  const raw = body();
  const parsed = parseQuestionHookInput(raw);
  assert.ok(parsed);
  assert.equal(parsed.toolUseId, 'toolu_1');
  assert.equal(parsed.toolInput, raw.tool_input);
  assert.deepEqual(parsed.questions, [{
    question: 'Which timeout?',
    header: 'Timeout',
    options: [{ label: 'Short', description: '30s' }, { label: 'Long (Recommended)', description: '5m' }],
    multiSelect: false,
  }]);
});

test('missing header, description and multiSelect get defaults; a preview is kept', () => {
  const parsed = parseQuestionHookInput(body({}, {
    questions: [{ question: 'Q?', options: [{ label: 'A', preview: '<b>A</b>' }, { label: 'B' }] }],
  }));
  assert.ok(parsed);
  assert.deepEqual(parsed.questions[0], {
    question: 'Q?',
    header: '',
    options: [{ label: 'A', description: '', preview: '<b>A</b>' }, { label: 'B', description: '' }],
    multiSelect: false,
  });
});

test('only a literal true makes a question multiple-choice', () => {
  const parse = (multiSelect: unknown) => parseQuestionHookInput(body({}, {
    questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], multiSelect }],
  }))?.questions[0].multiSelect;
  assert.equal(parse(true), true);
  assert.equal(parse('true'), false);
  assert.equal(parse(1), false);
});

test('a missing tool_use_id becomes empty rather than rejecting the call', () => {
  const parsed = parseQuestionHookInput(body({ tool_use_id: undefined }));
  assert.equal(parsed?.toolUseId, '');
});

test('anything other than an AskUserQuestion PreToolUse call is rejected', () => {
  for (const raw of [null, 'x', [], 42]) assert.equal(parseQuestionHookInput(raw), null);
  assert.equal(parseQuestionHookInput(body({ hook_event_name: 'PostToolUse' })), null);
  assert.equal(parseQuestionHookInput(body({ tool_name: 'Bash' })), null);
  assert.equal(parseQuestionHookInput(body({ tool_input: 'nope' })), null);
  assert.equal(parseQuestionHookInput(body({ tool_input: {} })), null);
});

test('a set with no questions, or any malformed question, is rejected', () => {
  const withQuestions = (questions: unknown) => parseQuestionHookInput(body({}, { questions }));
  const ok = { question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] };
  assert.equal(withQuestions([]), null);
  assert.equal(withQuestions([ok, { ...ok, question: '  ' }]), null);
  assert.equal(withQuestions([{ ...ok, question: 7 }]), null);
  assert.equal(withQuestions([{ ...ok, options: 'A,B' }]), null);
  assert.equal(withQuestions([{ ...ok, options: [{ label: 'A' }] }]), null, 'fewer than two options');
  assert.equal(withQuestions([{ ...ok, options: [{ label: 'A' }, { label: ' ' }] }]), null);
  assert.equal(withQuestions([{ ...ok, options: [{ label: 'A' }, 'B'] }]), null);
  assert.equal(withQuestions(['Q?']), null);
});

test('the response allows the call and echoes the tool input with the answers added', () => {
  const toolInput = { questions: [{ question: 'Q?' }], extra: 1 };
  const response = questionHookResponse(toolInput, { 'Q?': 'A' });
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Answered in Switchboard',
      updatedInput: { questions: [{ question: 'Q?' }], extra: 1, answers: { 'Q?': 'A' } },
    },
  });
  assert.deepEqual(toolInput, { questions: [{ question: 'Q?' }], extra: 1 }, 'the input is not mutated');
});

test('the settings install one http PreToolUse hook for AskUserQuestion only', () => {
  const settings = JSON.parse(questionHookSettings('http://127.0.0.1:4321/questions', 's3cret'));
  assert.deepEqual(settings, {
    hooks: {
      PreToolUse: [{
        matcher: 'AskUserQuestion',
        hooks: [{
          type: 'http',
          url: 'http://127.0.0.1:4321/questions',
          headers: { [QUESTION_HOOK_TOKEN_HEADER]: 's3cret' },
          statusMessage: QUESTION_HOOK_STATUS,
          timeout: QUESTION_HOOK_TIMEOUT_SECONDS,
        }],
      }],
    },
  });
});
