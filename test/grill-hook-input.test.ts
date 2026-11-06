import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    backgroundAgentIds,
    endedTurn,
    parsePromptHook,
    parseStopHook,
    parseSubagentHook,
    turnFromTranscript,
} from '../src/domain/grill/hook-input';

/**
 * Reading the grilling card's hooks: the turn a Stop ended, out of the
 * transcript's tail, and the prompt and subagent notices.
 */

const prompt = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({type: 'user', uuid, isSidechain: false, message: {role: 'user', content}, ...extra});

const toolResult = (uuid: string) => prompt(uuid, [{type: 'tool_result', tool_use_id: 'tu', content: 'ok'}]);

const assistant = (uuid: string, blocks: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        type: 'assistant',
        uuid,
        isSidechain: false,
        message: {role: 'assistant', content: blocks},
        ...extra,
    });

const text = (value: string) => ({type: 'text', text: value});
const toolUse = {type: 'tool_use', id: 'tu', name: 'Bash', input: {}};

const hash = (value: string) => `h${value.length}`;

test('the last turn runs from the last prompt, every text block in order', () => {
    /* Given */
    const lines = [
        prompt('u0', 'an earlier prompt'),
        assistant('a0', [text('an earlier answer')]),
        prompt('u1', 'grill me'),
        assistant('a1', [text('Looking around.')]),
        assistant('a2', [toolUse]),
        toolResult('r1'),
        assistant('a3', [text('The round.')]),
        JSON.stringify({type: 'system', uuid: 's1'}),
    ];

    /* When */
    const turn = turnFromTranscript(lines);

    /* Then */
    assert.deepEqual(turn, {
        texts: [
            {id: 'a1', text: 'Looking around.'},
            {id: 'a3', text: 'The round.'},
        ],
    });
});

test('a prompt given as text blocks starts a turn, a tool result does not', () => {
    /* Given */
    const lines = [
        assistant('a0', [text('before')]),
        prompt('u1', [text('look at this'), {type: 'image', source: {}}]),
        assistant('a1', [text('first')]),
        toolResult('r1'),
        assistant('a2', [text('second')]),
    ];

    /* When */
    const turn = turnFromTranscript(lines);

    /* Then */
    assert.deepEqual(
        turn?.texts.map((block) => block.id),
        ['a1', 'a2'],
    );
});

test('a turn woken by a background task starts at the notification, even a meta one', () => {
    /* Given */
    const lines = [
        prompt('u1', 'grill me'),
        assistant('a1', [text('Round one.')]),
        prompt('w1', '<task-notification>\n<task-id>x</task-id>\n</task-notification>'),
        assistant('a2', [text('Revised round.')]),
        prompt('w2', 'Another Claude session sent a message:\n<agent-message from="x">done</agent-message>', {
            isMeta: true,
        }),
        assistant('a3', [text('Round two.')]),
    ];

    /* When */
    const turn = turnFromTranscript(lines);

    /* Then */
    assert.deepEqual(turn, {texts: [{id: 'a3', text: 'Round two.'}]});
});

test("a meta user line that is not a wake-up (a skill's text) stays inside the turn", () => {
    /* Given */
    const lines = [
        prompt('u1', '/grill-me'),
        assistant('a1', [text('Loading.')]),
        prompt('m1', 'Base directory for this skill: …', {isMeta: true}),
        assistant('a2', [text('The round.')]),
    ];

    /* When */
    const turn = turnFromTranscript(lines);

    /* Then */
    assert.deepEqual(
        turn?.texts.map((block) => block.id),
        ['a1', 'a2'],
    );
});

test('subagent lines are ignored, and several text blocks on one line get numbered ids', () => {
    /* Given */
    const lines = [
        prompt('u1', 'go'),
        assistant('a1', [text('One.'), toolUse, text('Two.')]),
        prompt('s0', 'subagent prompt', {isSidechain: true}),
        assistant('s1', [text('subagent text')], {isSidechain: true}),
        assistant('a2', [text('  '), text('Three.')]),
    ];

    /* When */
    const turn = turnFromTranscript(lines);

    /* Then */
    assert.deepEqual(turn, {
        texts: [
            {id: 'a1#1', text: 'One.'},
            {id: 'a1#2', text: 'Two.'},
            {id: 'a2', text: 'Three.'},
        ],
    });
});

test('a tail cut mid-line skips the broken line and keeps what it holds', () => {
    /* Given */
    const lines = ['ext":"cut off"}]}}', assistant('a1', [text('Partial turn.')])];

    /* When */
    const turn = turnFromTranscript(lines);

    /* Then */
    assert.deepEqual(turn, {texts: [{id: 'a1', text: 'Partial turn.'}]});
});

test('nothing readable is null', () => {
    /* Given */
    const lines = ['not json', ''];

    /* When */
    const turn = turnFromTranscript(lines);

    /* Then */
    assert.equal(turn, null);
});

test("the ended turn is the transcript's when it ends on the Stop's last message", () => {
    /* Given */
    const lines = [prompt('u1', 'go'), assistant('a1', [text('Thinking.')]), assistant('a2', [text('The round.\n')])];

    /* When */
    const turn = endedTurn(lines, 'The round.', hash);

    /* Then */
    assert.deepEqual(turn, {
        texts: [
            {id: 'a1', text: 'Thinking.'},
            {id: 'a2', text: 'The round.\n'},
        ],
    });
});

test("a transcript that has not caught up falls back to the Stop's last message", () => {
    /* Given */
    const lines = [prompt('u1', 'go'), assistant('a1', [text('An older answer.')])];

    /* When */
    const turn = endedTurn(lines, 'The newest round.', hash);

    /* Then */
    assert.deepEqual(turn, {texts: [{id: 'stop-h17', text: 'The newest round.'}]});
});

test('with no transcript the turn is the last message, or empty when there is none', () => {
    /* Given */
    const lines = null;

    /* When */
    const withMessage = endedTurn(lines, 'All done.', hash);
    const withNone = endedTurn(lines, null, hash);
    const withBlank = endedTurn(['garbage'], '  ', hash);

    /* Then */
    assert.deepEqual(withMessage, {texts: [{id: 'stop-h9', text: 'All done.'}]});
    assert.deepEqual(withNone, {texts: []});
    assert.deepEqual(withBlank, {texts: []});
});

test('a Stop with no last message trusts the transcript (the turn ended on a tool call)', () => {
    /* Given */
    const lines = [prompt('u1', 'go'), assistant('a1', [text('The round.')]), assistant('a2', [toolUse])];

    /* When */
    const turn = endedTurn(lines, null, hash);

    /* Then */
    assert.deepEqual(turn, {texts: [{id: 'a1', text: 'The round.'}]});
});

test('a Stop body gives its transcript, last message and background agents', () => {
    /* Given */
    const body = {
        hook_event_name: 'Stop',
        transcript_path: '/t/s.jsonl',
        last_assistant_message: 'Done.',
        background_tasks: [
            {id: 'agent-1', type: 'subagent'},
            {task_id: 'agent-2', kind: 'local_agent'},
            {id: 'shell-1', type: 'local_bash'},
            'junk',
            {type: 'subagent'},
        ],
    };

    /* When */
    const stop = parseStopHook(body);

    /* Then */
    assert.deepEqual(stop, {
        transcriptPath: '/t/s.jsonl',
        lastMessage: 'Done.',
        backgroundAgents: ['agent-1', 'agent-2'],
    });
});

test('a Stop without background tasks says nothing about agents; other bodies are not a Stop', () => {
    /* Given */
    const bare = {hook_event_name: 'Stop'};

    /* When */
    const stop = parseStopHook(bare);

    /* Then */
    assert.deepEqual(stop, {transcriptPath: null, lastMessage: null, backgroundAgents: null});
    assert.equal(parseStopHook({hook_event_name: 'UserPromptSubmit'}), null);
    assert.equal(parseStopHook(null), null);
    assert.deepEqual(backgroundAgentIds([]), []);
    assert.equal(backgroundAgentIds({}), null);
});

test('SubagentStart and SubagentStop give the event and the agent id', () => {
    /* Given */
    const start = {hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore'};
    const stop = {hook_event_name: 'SubagentStop', agent_id: 'ag1'};

    /* When */
    const parsed = [parseSubagentHook(start), parseSubagentHook(stop)];

    /* Then */
    assert.deepEqual(parsed, [
        {event: 'start', agentId: 'ag1'},
        {event: 'stop', agentId: 'ag1'},
    ]);
    assert.equal(parseSubagentHook({hook_event_name: 'SubagentStop'}), null);
    assert.equal(parseSubagentHook({hook_event_name: 'Stop', agent_id: 'ag1'}), null);
});

test('UserPromptSubmit gives the prompt text', () => {
    /* Given */
    const body = {hook_event_name: 'UserPromptSubmit', prompt: 'Q1: yes'};

    /* When */
    const text = parsePromptHook(body);

    /* Then */
    assert.equal(text, 'Q1: yes');
    assert.equal(parsePromptHook({hook_event_name: 'UserPromptSubmit'}), '');
    assert.equal(parsePromptHook({}), null);
});
