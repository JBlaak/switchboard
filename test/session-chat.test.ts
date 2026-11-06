import {test} from 'node:test';
import assert from 'node:assert/strict';

import {chatMessagesOf, MAX_CHAT_TEXT, promptText, takeLines, toolLine} from '../src/domain/session/chat';

/**
 * A transcript read as a chat, for the phone's chat view: prompts, Claude's
 * text and one line per tool call, with everything else left out; and the
 * whole lines of a transcript the CLI is still appending to.
 */

const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}): string =>
    line({type: 'user', uuid, message: {role: 'user', content}, ...extra});
const assistant = (uuid: string, content: unknown[]): string =>
    line({type: 'assistant', uuid, message: {role: 'assistant', content}});

// ── The messages ──

test('a prompt, a reply and a tool call read as three messages, in order', () => {
    /* Given */
    const lines = [
        user('u1', 'Fix the login'),
        assistant('a1', [{type: 'thinking', thinking: 'hm'}]),
        assistant('a2', [{type: 'tool_use', name: 'Bash', input: {command: 'git status'}}]),
        user('u2', [{type: 'tool_result', tool_use_id: 't1', content: 'clean'}]),
        assistant('a3', [{type: 'text', text: 'Fixed it.\n'}]),
    ];

    /* When */
    const messages = chatMessagesOf(lines);

    /* Then */
    assert.deepEqual(messages, [
        {id: 'u1:0', role: 'user', text: 'Fix the login'},
        {id: 'a2:0', role: 'tool', text: 'Ran: git status'},
        {id: 'a3:0', role: 'assistant', text: 'Fixed it.'},
    ]);
});

test('every block of an entry is its own message, numbered by its place', () => {
    /* Given */
    const lines = [
        assistant('a1', [
            {type: 'text', text: 'Looking.'},
            {type: 'tool_use', name: 'Read', input: {file_path: '/Users/joris/app/src/login.ts'}},
        ]),
    ];

    /* When */
    const messages = chatMessagesOf(lines);

    /* Then */
    assert.deepEqual(messages, [
        {id: 'a1:0', role: 'assistant', text: 'Looking.'},
        {id: 'a1:1', role: 'tool', text: 'Read: …/src/login.ts'},
    ]);
});

test('meta, sidechain, compact summary and bookkeeping entries are left out', () => {
    /* Given */
    const lines = [
        user('u1', 'Caveat: local commands', {isMeta: true}),
        user('u2', 'A subagent prompt', {isSidechain: true}),
        user('u3', 'This session is being continued…', {isCompactSummary: true}),
        line({type: 'ai-title', aiTitle: 'Login'}),
        line({type: 'attachment', uuid: 'x1'}),
        user('', 'No uuid'),
        'not json',
        '',
    ];

    /* When */
    const messages = chatMessagesOf(lines);

    /* Then */
    assert.deepEqual(messages, []);
});

test('a reply longer than a message may be is cut with an ellipsis', () => {
    /* Given */
    const lines = [assistant('a1', [{type: 'text', text: 'x'.repeat(MAX_CHAT_TEXT + 10)}])];

    /* When */
    const [message] = chatMessagesOf(lines);

    /* Then */
    assert.equal(message.text.length, MAX_CHAT_TEXT);
    assert.ok(message.text.endsWith('…'));
});

// ── Prompts ──

test('a slash command reads as the command with its arguments', () => {
    /* When */
    const text = promptText(
        '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>42</command-args>',
    );

    /* Then */
    assert.equal(text, '/review 42');
});

test('a shell line reads as itself, and its output and command echoes as nothing', () => {
    /* When */
    const input = promptText('<bash-input>ls</bash-input>');
    const output = promptText('<bash-stdout>a.ts</bash-stdout><bash-stderr></bash-stderr>');
    const echo = promptText('<local-command-stdout>Done</local-command-stdout>');

    /* Then */
    assert.deepEqual([input, output, echo], ['! ls', '', '']);
});

test('system reminders are taken out of a prompt, and a prompt of only reminders is none', () => {
    /* When */
    const mixed = promptText('<system-reminder>be nice</system-reminder>\nShip it');
    const only = promptText('<system-reminder>be nice</system-reminder>');

    /* Then */
    assert.deepEqual([mixed, only], ['Ship it', '']);
});

// ── Tool lines ──

test('each tool call reads as what it did to what', () => {
    /* When */
    const lines = [
        toolLine('Bash', {command: 'npm test\nnpm run lint'}),
        toolLine('Edit', {file_path: 'src/a.ts'}),
        toolLine('Write', {file_path: '/x/y/z.md'}),
        toolLine('Grep', {pattern: 'TODO'}),
        toolLine('WebFetch', {url: 'https://example.com'}),
        toolLine('Agent', {description: 'Find the callers'}),
        toolLine('TodoWrite', {todos: []}),
        toolLine('mcp__github__create_issue', {}),
        toolLine('Bash', {}),
    ];

    /* Then */
    assert.deepEqual(lines, [
        'Ran: npm test …',
        'Edited: src/a.ts',
        'Wrote: …/y/z.md',
        'Searched: TODO',
        'Fetched: https://example.com',
        'Agent: Find the callers',
        'Updated the to-do list',
        'Used: mcp__github__create_issue',
        'Ran',
    ]);
});

// ── Whole lines of a growing transcript ──

test('whole lines are taken and a line still being written waits', () => {
    /* Given */
    const text = '{"a":1}\n{"b":2}\n{"c":';

    /* When */
    const taken = takeLines({text, bytes: text.length, more: false, midLine: false});

    /* Then */
    assert.deepEqual(taken, {lines: ['{"a":1}', '{"b":2}'], consumed: 16, midLine: false});
});

test('bytes are counted as UTF-8, not as characters', () => {
    /* Given */
    const text = '{"t":"café ✓"}\n';

    /* When */
    const taken = takeLines({text, bytes: Buffer.byteLength(text), more: false, midLine: false});

    /* Then */
    assert.equal(taken.consumed, Buffer.byteLength(text));
});

test('a read that began inside a line drops that line, counting from the end', () => {
    /* Given */
    const text = '�tail of a line}\n{"a":1}\n{"b"';
    const bytes = 2 + Buffer.byteLength('tail of a line}\n{"a":1}\n{"b"');

    /* When */
    const taken = takeLines({text, bytes, more: false, midLine: true});

    /* Then */
    assert.deepEqual(taken, {lines: ['{"a":1}'], consumed: bytes - Buffer.byteLength('{"b"'), midLine: false});
});

test('a line longer than a whole read is skipped, and the read after it drops its rest', () => {
    /* Given */
    const first = '{"huge":"xxxx';
    const second = 'xxxx"}\n{"a":1}\n';

    /* When */
    const skipped = takeLines({text: first, bytes: first.length, more: true, midLine: false});
    const after = takeLines({text: second, bytes: second.length, more: false, midLine: skipped.midLine});

    /* Then */
    assert.deepEqual(skipped, {lines: [], consumed: first.length, midLine: true});
    assert.deepEqual(after, {lines: ['{"a":1}'], consumed: second.length, midLine: false});
});
