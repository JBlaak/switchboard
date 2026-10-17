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
  /* Given */
  const raw = body();

  /* When */
  const parsed = parseQuestionHookInput(raw);

  /* Then */
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
  /* Given */
  const raw = body({}, {
    questions: [{ question: 'Q?', options: [{ label: 'A', preview: '<b>A</b>' }, { label: 'B' }] }],
  });

  /* When */
  const parsed = parseQuestionHookInput(raw);

  /* Then */
  assert.ok(parsed);
  assert.deepEqual(parsed.questions[0], {
    question: 'Q?',
    header: '',
    options: [{ label: 'A', description: '', preview: '<b>A</b>' }, { label: 'B', description: '' }],
    multiSelect: false,
  });
});

test('only a literal true makes a question multiple-choice', () => {
  /* Given */
  const parse = (multiSelect: unknown) => parseQuestionHookInput(body({}, {
    questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], multiSelect }],
  }))?.questions[0].multiSelect;
  const cases: Array<[unknown, boolean]> = [[true, true], ['true', false], [1, false]];

  for (const [multiSelect, expected] of cases) {
    /* When */
    const parsed = parse(multiSelect);

    /* Then */
    assert.equal(parsed, expected);
  }
});

test('a missing tool_use_id becomes empty rather than rejecting the call', () => {
  /* When */
  const parsed = parseQuestionHookInput(body({ tool_use_id: undefined }));

  /* Then */
  assert.equal(parsed?.toolUseId, '');
});

test('anything that is not an object is rejected', () => {
  /* Given */
  const raws: unknown[] = [null, 'x', [], 42];

  for (const raw of raws) {
    /* When */
    const parsed = parseQuestionHookInput(raw);

    /* Then */
    assert.equal(parsed, null);
  }
});

test('anything other than an AskUserQuestion PreToolUse call is rejected', () => {
  /* Given */
  const raws = [
    body({ hook_event_name: 'PostToolUse' }),
    body({ tool_name: 'Bash' }),
    body({ tool_input: 'nope' }),
    body({ tool_input: {} }),
  ];

  for (const raw of raws) {
    /* When */
    const parsed = parseQuestionHookInput(raw);

    /* Then */
    assert.equal(parsed, null);
  }
});

test('a set with no questions, or any malformed question, is rejected', () => {
  /* Given */
  const withQuestions = (questions: unknown) => parseQuestionHookInput(body({}, { questions }));
  const ok = { question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] };
  const cases: Array<[unknown, string]> = [
    [[], 'no questions'],
    [[ok, { ...ok, question: '  ' }], 'a blank question'],
    [[{ ...ok, question: 7 }], 'a non-string question'],
    [[{ ...ok, options: 'A,B' }], 'options not a list'],
    [[{ ...ok, options: [{ label: 'A' }] }], 'fewer than two options'],
    [[{ ...ok, options: [{ label: 'A' }, { label: ' ' }] }], 'a blank option label'],
    [[{ ...ok, options: [{ label: 'A' }, 'B'] }], 'an option that is not an object'],
    [['Q?'], 'a question that is not an object'],
  ];

  for (const [questions, message] of cases) {
    /* When */
    const parsed = withQuestions(questions);

    /* Then */
    assert.equal(parsed, null, message);
  }
});

test('the response allows the call and echoes the tool input with the answers added', () => {
  /* Given */
  const toolInput = { questions: [{ question: 'Q?' }], extra: 1 };

  /* When */
  const response = questionHookResponse(toolInput, { 'Q?': 'A' });

  /* Then */
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Answered in Switchboard',
      updatedInput: { questions: [{ question: 'Q?' }], extra: 1, answers: { 'Q?': 'A' } },
    },
  });
});

test('the response does not mutate the tool input', () => {
  /* Given */
  const toolInput = { questions: [{ question: 'Q?' }], extra: 1 };

  /* When */
  questionHookResponse(toolInput, { 'Q?': 'A' });

  /* Then */
  assert.deepEqual(toolInput, { questions: [{ question: 'Q?' }], extra: 1 }, 'the input is not mutated');
});

test('the settings install one http PreToolUse hook for AskUserQuestion only', () => {
  /* When */
  const settings = JSON.parse(questionHookSettings('http://127.0.0.1:4321/questions', 's3cret'));

  /* Then */
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
