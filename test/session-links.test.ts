import {test} from 'node:test';
import assert from 'node:assert/strict';

import {artifactsInTranscript} from '../src/domain/session/artifacts';
import {sessionLinks, type SessionLinkFacts} from '../src/domain/session/links';
import {PAGE_TOOL_QUALIFIED_NAME, shownPagesInTranscript} from '../src/domain/session/page-tool';
import type {PullRequestStatus} from '../src/domain/session-work/model';

/**
 * A session's links (#340): the artifacts and pages its transcript records,
 * and the one list the session tray's Links group shows.
 */

const REPO = 'acme/web';

const assistantText = (text: string, timestamp = '2026-11-06T10:00:00Z') =>
    JSON.stringify({type: 'assistant', timestamp, message: {role: 'assistant', content: [{type: 'text', text}]}});
const userText = (text: string) => JSON.stringify({type: 'user', message: {role: 'user', content: text}});
const toolUse = (id: string, name: string, input: unknown, timestamp = '2026-11-06T10:00:00Z') =>
    JSON.stringify({
        type: 'assistant',
        timestamp,
        message: {role: 'assistant', content: [{type: 'tool_use', id, name, input}]},
    });
const toolResult = (id: string, content: unknown, isError = false) =>
    JSON.stringify({
        type: 'user',
        message: {
            role: 'user',
            content: [{type: 'tool_result', tool_use_id: id, content, ...(isError ? {is_error: true} : {})}],
        },
    });

// ── Artifacts ──

test('an artifact the Artifact tool published is a link, named after the URL id', () => {
    /* Given */
    const lines = [
        toolUse('t1', 'Artifact', {file_path: '/tmp/report.html'}),
        toolResult(
            't1',
            'Published /tmp/report.html at https://claude.ai/artifact/FZB9NfPPJx (Version 1, version id 17) Icon: "chart".',
        ),
    ];

    /* When */
    const artifacts = artifactsInTranscript(lines);

    /* Then */
    assert.deepEqual(artifacts, [{id: 'FZB9NfPPJx', url: 'https://claude.ai/artifact/FZB9NfPPJx', title: null}]);
});

test("an artifact created from a type takes its call's title, and not the type's URL", () => {
    /* Given */
    const lines = [
        toolUse('t1', 'Artifact', {type_url: 'https://claude.ai/artifact/TypeAbc', title: 'Force curve wall'}),
        toolResult('t1', [
            {
                type: 'text',
                text: 'Created a new Artifact at https://claude.ai/artifact/3qnCYw (version 1) from the Artifact type https://claude.ai/artifact/TypeAbc (release 2).',
            },
        ]),
    ];

    /* When */
    const artifacts = artifactsInTranscript(lines);

    /* Then */
    assert.deepEqual(artifacts, [{id: '3qnCYw', url: 'https://claude.ai/artifact/3qnCYw', title: 'Force curve wall'}]);
});

test("artifact links in Claude's replies count, the code URL form too", () => {
    /* Given */
    const lines = [assistantText('Here it is: https://claude.ai/code/artifact/0b5e-41aa?tab=1 and that is all.')];

    /* When */
    const artifacts = artifactsInTranscript(lines);

    /* Then */
    assert.deepEqual(artifacts, [{id: '0b5e-41aa', url: 'https://claude.ai/code/artifact/0b5e-41aa', title: null}]);
});

test('one artifact published, updated and linked again is one link, where it first appeared', () => {
    /* Given */
    const lines = [
        toolUse('t1', 'Artifact', {file_path: '/tmp/a.html'}),
        toolResult('t1', 'Published /tmp/a.html at https://claude.ai/artifact/AAA (Version 1)'),
        assistantText('Published: https://claude.ai/artifact/AAA'),
        toolUse('t2', 'Artifact', {file_path: '/tmp/b.html'}),
        toolResult('t2', 'Published /tmp/b.html at https://claude.ai/artifact/BBB (Version 1)'),
        toolUse('t3', 'Artifact', {url: 'https://claude.ai/artifact/AAA', file_path: '/tmp/a.html'}),
        toolResult('t3', 'Updated the Artifact at https://claude.ai/artifact/AAA (Version 2)'),
    ];

    /* When */
    const artifacts = artifactsInTranscript(lines);

    /* Then */
    assert.deepEqual(
        artifacts.map((artifact) => artifact.id),
        ['AAA', 'BBB'],
    );
});

test('artifact URLs a tool result only mentions, your own messages and failed calls are not links', () => {
    /* Given */
    const lines = [
        userText('Design: https://claude.ai/artifact/Mine'),
        toolUse('t1', 'Bash', {command: 'gh issue view 340'}),
        toolResult('t1', 'Design: https://claude.ai/artifact/FromIssue'),
        toolUse('t2', 'Artifact', {action: 'quickstart'}),
        toolResult(
            't2',
            'start from the Motion type: publish with `type_url`: "https://claude.ai/artifact/MotionType"',
        ),
        toolUse('t3', 'Artifact', {file_path: '/tmp/x.html'}),
        toolResult('t3', 'Published /tmp/x.html at https://claude.ai/artifact/Refused', true),
    ];

    /* When */
    const artifacts = artifactsInTranscript(lines);

    /* Then */
    assert.deepEqual(artifacts, []);
});

// ── Pages ──

test('a page shown with show_page is a page, by its call id and title, with when it was shown', () => {
    /* Given */
    const lines = [
        toolUse('p1', PAGE_TOOL_QUALIFIED_NAME, {title: 'The contract', html: '<p>Hi</p>'}, '2026-11-06T10:00:00Z'),
        toolResult('p1', 'The page is open in Switchboard.'),
    ];

    /* When */
    const pages = shownPagesInTranscript(lines);

    /* Then */
    assert.deepEqual(pages, [{id: 'p1', title: 'The contract', shownAt: Date.parse('2026-11-06T10:00:00Z')}]);
});

test('a show_page call that failed or was not a page showed nothing', () => {
    /* Given */
    const lines = [
        toolUse('p1', PAGE_TOOL_QUALIFIED_NAME, {title: 'No window', html: '<p>x</p>'}),
        toolResult('p1', 'No Switchboard window is open to show the page in.', true),
        toolUse('p2', PAGE_TOOL_QUALIFIED_NAME, {title: ''}),
        toolUse('p3', 'mcp__other__show_page', {title: 'Elsewhere', html: '<p>x</p>'}),
    ];

    /* When */
    const pages = shownPagesInTranscript(lines);

    /* Then */
    assert.deepEqual(pages, []);
});

// ── The list ──

function facts(overrides: Partial<SessionLinkFacts> = {}): SessionLinkFacts {
    return {
        repository: REPO,
        pullRequests: [],
        pullRequestStatuses: null,
        issueMentions: [],
        issueStatuses: null,
        artifacts: [],
        pages: [],
        task: null,
        ...overrides,
    };
}

const pr = (number: number, repository = REPO) => ({
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    repository,
});

test('the kinds come PRs, issues, artifacts, pages, task; each newest first', () => {
    /* Given */
    const input = facts({
        pullRequests: [pr(10), pr(11)],
        issueMentions: [
            {repository: '', number: 3},
            {repository: '', number: 4},
        ],
        artifacts: [
            {id: 'A1', url: 'https://claude.ai/artifact/A1', title: 'First'},
            {id: 'A2', url: 'https://claude.ai/artifact/A2', title: null},
        ],
        pages: [
            {id: 'p1', title: 'One', shownAt: 1},
            {id: 'p2', title: 'Two', shownAt: 2},
        ],
        task: {id: 'task-1', detail: null},
    });

    /* When */
    const links = sessionLinks(input);

    /* Then */
    assert.deepEqual(
        links.map((link) => [link.kind, link.title]),
        [
            ['pr', 'acme/web#11'],
            ['pr', 'acme/web#10'],
            ['issue', 'acme/web#4'],
            ['issue', 'acme/web#3'],
            ['artifact', 'A2'],
            ['artifact', 'First'],
            ['page', 'Two'],
            ['page', 'One'],
            ['task', 'Task'],
        ],
    );
});

test("a PR carries gh's title and state, with its checks folded and the sidebar's dot", () => {
    /* Given */
    const status: PullRequestStatus = {
        ...pr(10),
        title: 'Add the tray',
        state: 'open',
        checks: [
            {name: 'lint', state: 'passing'},
            {name: 'test', state: 'pending'},
        ],
        closes: [],
    };
    const merged: PullRequestStatus = {...pr(11), title: 'Earlier', state: 'merged', closes: []};

    /* When */
    const links = sessionLinks(facts({pullRequests: [pr(10), pr(11)], pullRequestStatuses: [status, merged]}));

    /* Then */
    assert.deepEqual(links, [
        {
            kind: 'pr',
            key: 'pr:https://github.com/acme/web/pull/11',
            title: 'Earlier',
            url: 'https://github.com/acme/web/pull/11',
            repository: REPO,
            number: 11,
            status: {state: 'merged', checks: 'none', dot: 'merged'},
        },
        {
            kind: 'pr',
            key: 'pr:https://github.com/acme/web/pull/10',
            title: 'Add the tray',
            url: 'https://github.com/acme/web/pull/10',
            repository: REPO,
            number: 10,
            status: {state: 'open', checks: 'pending', dot: 'amber'},
        },
    ]);
});

test('without gh a PR comes back without status', () => {
    /* When */
    const links = sessionLinks(facts({pullRequests: [pr(10)], pullRequestStatuses: null}));

    /* Then */
    assert.deepEqual(
        links.map((link) => link.status),
        [null],
    );
});

test('an issue a PR closes, or that is the PR itself, is not listed again', () => {
    /* Given */
    const status: PullRequestStatus = {...pr(10), state: 'open', closes: [{repository: REPO, number: 3}]};

    /* When */
    const links = sessionLinks(
        facts({
            pullRequests: [pr(10)],
            pullRequestStatuses: [status],
            issueMentions: [
                {repository: '', number: 3},
                {repository: '', number: 10},
                {repository: '', number: 5},
            ],
        }),
    );

    /* Then */
    assert.deepEqual(
        links.filter((link) => link.kind === 'issue').map((link) => link.key),
        ['issue:acme/web#5'],
    );
});

test('an issue gh confirmed carries its title and state; a mention gh says is no issue drops out', () => {
    /* Given */
    const issueStatuses = new Map([
        [REPO, [{repository: REPO, number: 3, title: 'Tray', state: 'closed' as const, url: 'https://x/3'}]],
    ]);

    /* When */
    const links = sessionLinks(
        facts({
            issueMentions: [
                {repository: '', number: 3},
                {repository: '', number: 88},
            ],
            issueStatuses,
        }),
    );

    /* Then */
    assert.deepEqual(links, [
        {
            kind: 'issue',
            key: 'issue:acme/web#3',
            title: 'Tray',
            url: 'https://x/3',
            repository: REPO,
            number: 3,
            status: 'closed',
        },
    ]);
});

test('an issue in no known repository has nowhere to open and is left out', () => {
    /* When */
    const links = sessionLinks(facts({repository: '', issueMentions: [{repository: '', number: 3}]}));

    /* Then */
    assert.deepEqual(links, []);
});

test("the task carries BlaakTasks' title, page and status once it answered", () => {
    /* Given */
    const task = {
        id: 'task-1',
        detail: {title: 'Ship the tray', url: 'https://notion.so/t1', status: 'In progress' as const},
    };

    /* When */
    const links = sessionLinks(facts({task}));

    /* Then */
    assert.deepEqual(links, [
        {
            kind: 'task',
            key: 'task:task-1',
            title: 'Ship the tray',
            id: 'task-1',
            url: 'https://notion.so/t1',
            status: 'In progress',
        },
    ]);
});
