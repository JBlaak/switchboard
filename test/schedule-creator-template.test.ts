/**
 * The `/create-switchboard-schedule` command's text: it points at the
 * Schedule manager, writes schedules off, documents every frontmatter key the
 * manager reads, and asks for a prompt that runs unattended.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SCHEDULE_CREATOR_TEMPLATE} from '../src/domain/schedule/creator-template';

test('the command sends the user to the Schedule manager, not the old brain tab', () => {
    /* When */
    const text = SCHEDULE_CREATOR_TEMPLATE;

    /* Then */
    assert.doesNotMatch(text, /brain tab/);
    assert.match(text, /Schedule manager as New/);
});

test('the command writes a new schedule off, until the user turns it on', () => {
    /* When */
    const text = SCHEDULE_CREATOR_TEMPLATE;

    /* Then */
    assert.match(text, /^enabled: false$/m);
});

test('the command documents the missed, limit, week cap and worktree keys', () => {
    /* When */
    const text = SCHEDULE_CREATOR_TEMPLATE;

    /* Then */
    for (const line of [/^missed: run-once$/m, /^limit-minutes: \d+$/m, /^week-cap: \d+$/m, /^worktree: true$/m]) {
        assert.match(text, line);
    }
    assert.match(text, /`run-once`.*`skip`/);
});

test('the command asks for a prompt that runs unattended and ends with a short report', () => {
    /* When */
    const text = SCHEDULE_CREATOR_TEMPLATE;

    /* Then */
    assert.match(text, /runs unattended/);
    assert.match(text, /End with a short report/);
});

test('the command never talks about money', () => {
    /* When */
    const text = SCHEDULE_CREATOR_TEMPLATE;

    /* Then */
    assert.doesNotMatch(text, /budget|usd|\$\d/i);
});
