import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    interruptedLabel,
    interruptionFromTail,
    parseLiveSessions,
    rekeyLiveSession,
    restoreOrder,
    withLiveSession,
    withoutLiveSessions,
} from '../src/domain/session/restore';
import {resolveRestoreSessions} from '../src/domain/settings/settings';

/**
 * The record of live local sessions a restart brings back, and where a
 * cut-off session's turn stood.
 */

const entry = (sessionId: string, startedAt = '2026-11-06T10:00:00.000Z', projectPath = '/repo') => ({
    sessionId,
    projectPath,
    startedAt,
});

const line = (value: unknown): string => JSON.stringify(value);
const toolUse = (id: string, name: string) =>
    line({type: 'assistant', message: {content: [{type: 'tool_use', id, name, input: {}}]}});
const toolResult = (id: string) =>
    line({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: id, content: 'ok'}]}});
const prompt = (text: string) => line({type: 'user', message: {content: text}});
const assistantText = (text: string) => line({type: 'assistant', message: {content: [{type: 'text', text}]}});

// --- The record ---

test('a stored record that is not a list reads as empty', () => {
    /* When */
    const entries = parseLiveSessions({a: 1});

    /* Then */
    assert.deepEqual(entries, []);
});

test('malformed entries are left out of the stored record', () => {
    /* When */
    const entries = parseLiveSessions([entry('a'), {sessionId: 'b'}, null, 'c']);

    /* Then */
    assert.deepEqual(entries, [entry('a')]);
});

test('a session resumed again keeps its first start', () => {
    /* Given */
    const entries = [entry('a', '2026-11-06T09:00:00.000Z')];

    /* When */
    const next = withLiveSession(entries, entry('a', '2026-11-06T11:00:00.000Z', '/other'));

    /* Then */
    assert.deepEqual(next, [entry('a', '2026-11-06T09:00:00.000Z', '/other')]);
});

test('a session that ended leaves the record', () => {
    /* Given */
    const entries = [entry('a'), entry('b')];

    /* When */
    const next = withoutLiveSessions(entries, ['a']);

    /* Then */
    assert.deepEqual(next, [entry('b')]);
});

test('a re-keyed session is kept under its new id', () => {
    /* Given */
    const entries = [entry('old', '2026-11-06T09:00:00.000Z')];

    /* When */
    const next = rekeyLiveSession(entries, 'old', 'new');

    /* Then */
    assert.deepEqual(next, [entry('new', '2026-11-06T09:00:00.000Z')]);
});

test('the record is restored first started first', () => {
    /* Given */
    const entries = [entry('late', '2026-11-06T12:00:00.000Z'), entry('early', '2026-11-06T08:00:00.000Z')];

    /* When */
    const order = restoreOrder(entries).map((e) => e.sessionId);

    /* Then */
    assert.deepEqual(order, ['early', 'late']);
});

// --- Where the turn stood ---

test('a tool use without a result is an interruption, named after the tool', () => {
    /* Given */
    const tail = [prompt('run the tests'), toolUse('t1', 'Bash')].join('\n');

    /* When */
    const interruption = interruptionFromTail(tail);

    /* Then */
    assert.deepEqual(interruption, {tool: 'Bash'});
});

test('a pending question is an interruption too', () => {
    /* Given */
    const tail = [prompt('plan it'), assistantText('A question first.'), toolUse('q1', 'AskUserQuestion')].join('\n');

    /* When */
    const interruption = interruptionFromTail(tail);

    /* Then */
    assert.deepEqual(interruption, {tool: 'AskUserQuestion'});
});

test('a turn whose tools all returned is not an interruption', () => {
    /* Given */
    const tail = [prompt('run it'), toolUse('t1', 'Bash'), toolResult('t1'), assistantText('Done.')].join('\n');

    /* When */
    const interruption = interruptionFromTail(tail);

    /* Then */
    assert.equal(interruption, null);
});

test('of parallel tool uses, the one still open is named', () => {
    /* Given */
    const tail = [prompt('look'), toolUse('a', 'Read'), toolUse('b', 'Grep'), toolResult('a')].join('\n');

    /* When */
    const interruption = interruptionFromTail(tail);

    /* Then */
    assert.deepEqual(interruption, {tool: 'Grep'});
});

test('a new prompt closes a tool use left open before it', () => {
    /* Given */
    const tail = [toolUse('t1', 'Bash'), prompt('never mind'), assistantText('OK.')].join('\n');

    /* When */
    const interruption = interruptionFromTail(tail);

    /* Then */
    assert.equal(interruption, null);
});

test('a subagent’s open tool use is not the session’s', () => {
    /* Given */
    const sidechain = line({
        type: 'assistant',
        isSidechain: true,
        message: {content: [{type: 'tool_use', id: 's1', name: 'Read'}]},
    });
    const tail = [prompt('go'), sidechain, assistantText('Done.')].join('\n');

    /* When */
    const interruption = interruptionFromTail(tail);

    /* Then */
    assert.equal(interruption, null);
});

test('a cut first line and bookkeeping lines are skipped', () => {
    /* Given */
    const tail = ['"tool_use_id":"x"}]}}', toolUse('t1', 'Edit'), line({type: 'last-prompt'}), ''].join('\n');

    /* When */
    const interruption = interruptionFromTail(tail);

    /* Then */
    assert.deepEqual(interruption, {tool: 'Edit'});
});

test('the label names the tool when it is known', () => {
    /* When */
    const labels = [interruptedLabel({tool: 'Bash'}), interruptedLabel({tool: null})];

    /* Then */
    assert.deepEqual(labels, ['Interrupted by restart: Bash', 'Interrupted by restart']);
});

// --- The setting ---

test('bringing sessions back is on unless switched off', () => {
    /* When */
    const values = [
        resolveRestoreSessions(null),
        resolveRestoreSessions({}),
        resolveRestoreSessions({restoreSessions: false}),
    ];

    /* Then */
    assert.deepEqual(values, [true, true, false]);
});
