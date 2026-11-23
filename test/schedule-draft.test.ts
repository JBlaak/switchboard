/**
 * Claude's schedule draft: what the call is told, how its answer is checked
 * and filled with the defaults, and a session read into a conversation.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {DRAFT_DEFAULTS, conversationText, draftArgs, draftPrompt, readDraftRun} from '../src/domain/schedule/draft';
import type {DraftRequest} from '../src/domain/schedule/draft';
import type {ClaudeRun} from '../src/domain/ask/route';

const APP = '/Users/me/code/app';
const SITE = '/Users/me/code/site';

const REQUEST: DraftRequest = {
    ask: {kind: 'sentence', text: 'Check for outdated dependencies every night'},
    projectPath: null,
    projects: [
        {projectPath: APP, recentTitles: ['Fix login']},
        {projectPath: SITE, recentTitles: []},
    ],
    existing: [{name: 'Changelog tidy', cron: '0 3 * * *', projectPath: SITE}],
};

const ANSWER = {
    name: 'Nightly dependency check',
    slug: 'nightly-dependency-check',
    cron: '20 3 * * *',
    whenReason: '"every night"; 03:20 because the changelog runs at 03:00',
    prompt: 'Check the dependencies. End with a short report.',
    allowedTools: 'Read,Bash(npm outdated:*)',
    projectPath: APP,
};

function answered(result: unknown, fields: Partial<ClaudeRun> = {}): ClaudeRun {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return {
        exitCode: 0,
        stdout: JSON.stringify({type: 'result', is_error: false, result: text}) + '\n',
        stderr: '',
        ...fields,
    };
}

test('the draft is one Sonnet call with no tools', () => {
    /* When */
    const args = draftArgs('the prompt');

    /* Then */
    assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'sonnet']);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.length - 1], 'the prompt');
});

test('the prompt carries the sentence, the projects to pick from and the existing schedules', () => {
    /* When */
    const prompt = draftPrompt(REQUEST);

    /* Then */
    assert.match(prompt, /<request>\nCheck for outdated dependencies every night\n<\/request>/);
    assert.match(prompt, /\/Users\/me\/code\/app \(recent: Fix login\)/);
    assert.match(prompt, /- 0 3 \* \* \* {2}Changelog tidy \(\/Users\/me\/code\/site\)/);
});

test('a project already chosen is named instead of a list', () => {
    /* When */
    const prompt = draftPrompt({...REQUEST, projectPath: APP, projects: []});

    /* Then */
    assert.match(prompt, /It runs in \/Users\/me\/code\/app/);
    assert.doesNotMatch(prompt, /<projects>/);
});

test('a good answer becomes a draft with the defaults for the rest', () => {
    /* When */
    const result = readDraftRun(answered(ANSWER), REQUEST);

    /* Then */
    assert.deepEqual(result, {
        draft: {
            settings: {
                ...DRAFT_DEFAULTS,
                name: 'Nightly dependency check',
                slug: 'nightly-dependency-check',
                projectPath: APP,
                cron: '20 3 * * *',
                prompt: 'Check the dependencies. End with a short report.',
                allowedTools: 'Read,Bash(npm outdated:*)',
            },
            whenReason: '"every night"; 03:20 because the changelog runs at 03:00',
        },
    });
});

test('the defaults are the ones a nightly run starts from', () => {
    /* Then */
    assert.deepEqual(DRAFT_DEFAULTS, {
        enabled: true,
        model: null,
        permissionMode: 'acceptEdits',
        limitMinutes: 30,
        weekCap: 80,
        missed: 'run-once',
        worktree: true,
    });
});

test('an answer in a json fence is read too', () => {
    /* When */
    const result = readDraftRun(answered('```json\n' + JSON.stringify(ANSWER) + '\n```'), REQUEST);

    /* Then */
    assert.ok('draft' in result);
});

test('a project Claude made up is never drafted into', () => {
    /* When */
    const result = readDraftRun(answered({...ANSWER, projectPath: '/etc'}), REQUEST);

    /* Then */
    assert.deepEqual(result, {error: 'Claude could not tell which project this is for. Pick one and try again.'});
});

test('the project asked for wins over the one Claude names', () => {
    /* When */
    const result = readDraftRun(answered({...ANSWER, projectPath: SITE}), {...REQUEST, projectPath: APP});

    /* Then */
    assert.equal('draft' in result && result.draft.settings.projectPath, APP);
});

test('a cron the scheduler cannot read is refused', () => {
    /* When */
    const result = readDraftRun(answered({...ANSWER, cron: '0 3 * * MON'}), REQUEST);

    /* Then */
    assert.ok('error' in result && /cannot read \(0 3 \* \* MON\)/.test(result.error));
});

test('a slug Claude wrote badly is made from the name', () => {
    /* When */
    const result = readDraftRun(answered({...ANSWER, slug: ''}), REQUEST);

    /* Then */
    assert.equal('draft' in result && result.draft.settings.slug, 'nightly-dependency-check');
});

test('prose instead of JSON is a garbled answer', () => {
    /* When */
    const result = readDraftRun(answered('Sure! Here is your schedule.'), REQUEST);

    /* Then */
    assert.ok('error' in result && /could not be read/.test(result.error));
});

test('a usage limit says so', () => {
    /* Given */
    const run: ClaudeRun = {
        exitCode: 1,
        stdout: JSON.stringify({type: 'result', is_error: true, result: "You've hit your limit · resets 3pm"}),
        stderr: '',
    };

    /* When */
    const result = readDraftRun(run, REQUEST);

    /* Then */
    assert.deepEqual(result, {error: 'You’ve hit your usage limit — resets 3pm.'});
});

test('a session reads as its messages, each once, labelled by who said them', () => {
    /* Given: the head and the tail overlap */
    const messages = [
        {id: 'a', role: 'user' as const, text: 'Bump the deps'},
        {id: 'b', role: 'tool' as const, text: 'Ran: npm outdated'},
        {id: 'b', role: 'tool' as const, text: 'Ran: npm outdated'},
        {id: 'c', role: 'assistant' as const, text: 'Bumped three.'},
    ];

    /* When */
    const text = conversationText(messages);

    /* Then */
    assert.equal(text, 'User: Bump the deps\n\nTool: Ran: npm outdated\n\nClaude: Bumped three.');
});

test('a long session keeps its start and its end', () => {
    /* Given */
    const messages = [
        {id: 'first', role: 'user' as const, text: 'FIRST ASK'},
        ...Array.from({length: 50}, (_, i) => ({id: `m${i}`, role: 'assistant' as const, text: 'x'.repeat(100)})),
        {id: 'last', role: 'assistant' as const, text: 'LAST WORD'},
    ];

    /* When */
    const text = conversationText(messages, 1000);

    /* Then */
    assert.ok(text.length <= 1000);
    assert.match(text, /^User: FIRST ASK/);
    assert.match(text, /LAST WORD$/);
});
