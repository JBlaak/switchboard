/**
 * Patch's answer as drawn (`answer-blocks`): paragraphs, inline code, and
 * commands on their own as code blocks.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {answerBlocks} from '../src/renderer/ui/ask/answer-blocks';

test('blank lines split paragraphs, and runs of them make no empty paragraphs', () => {
    /* Given */
    const answer = 'First line.\n\n\n  \nSecond line.\n';

    /* When */
    const blocks = answerBlocks(answer);

    /* Then */
    assert.deepEqual(blocks, [
        {kind: 'text', lines: [[{code: false, text: 'First line.'}]]},
        {kind: 'text', lines: [[{code: false, text: 'Second line.'}]]},
    ]);
});

test('a command on its own in backticks is a code block', () => {
    /* Given */
    const answer = 'Run this:\n\n`sudo lsof -iTCP -sTCP:LISTEN -n -P`';

    /* When */
    const blocks = answerBlocks(answer);

    /* Then */
    assert.deepEqual(blocks[1], {kind: 'code', text: 'sudo lsof -iTCP -sTCP:LISTEN -n -P'});
});

test('several backticked lines together are one code block', () => {
    /* Given */
    const answer = '`git fetch`\n`git rebase origin/main`';

    /* When */
    const blocks = answerBlocks(answer);

    /* Then */
    assert.deepEqual(blocks, [{kind: 'code', text: 'git fetch\ngit rebase origin/main'}]);
});

test('a fence is a code block too, without its fence', () => {
    /* Given */
    const answer = '```sh\nlsof -i -P\n```';

    /* When */
    const blocks = answerBlocks(answer);

    /* Then */
    assert.deepEqual(blocks, [{kind: 'code', text: 'lsof -i -P'}]);
});

test('backticks inside a sentence are inline code', () => {
    /* Given */
    const answer = 'For UDP too, use `sudo lsof -iUDP -n -P` instead.';

    /* When */
    const [block] = answerBlocks(answer);

    /* Then */
    assert.deepEqual(block, {
        kind: 'text',
        lines: [
            [
                {code: false, text: 'For UDP too, use '},
                {code: true, text: 'sudo lsof -iUDP -n -P'},
                {code: false, text: ' instead.'},
            ],
        ],
    });
});

test('a paragraph mixing text and a code line stays text, its lines kept', () => {
    /* Given */
    const answer = 'Run this:\n`lsof -i`';

    /* When */
    const [block] = answerBlocks(answer);

    /* Then */
    assert.deepEqual(block, {
        kind: 'text',
        lines: [[{code: false, text: 'Run this:'}], [{code: true, text: 'lsof -i'}]],
    });
});
