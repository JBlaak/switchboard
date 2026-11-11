import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summaryFromUserMessage} from '../src/domain/session/transcript';

const command = (name: string, args = ''): string =>
    `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`;

test('the /clear echo that opens a cleared session gives no label', () => {
    /* When */
    const summary = summaryFromUserMessage(command('clear'));

    /* Then */
    assert.equal(summary, '');
});

test('a slash command reads as the command and its arguments', () => {
    /* When */
    const summary = summaryFromUserMessage(command('review-pr', '412'));

    /* Then */
    assert.equal(summary, '/review-pr 412');
});

test('a typed prompt is the label', () => {
    /* When */
    const summary = summaryFromUserMessage('Fix the build');

    /* Then */
    assert.equal(summary, 'Fix the build');
});
