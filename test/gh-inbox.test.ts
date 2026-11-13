/**
 * The Issue manager's read of a repository (#413), mapped from a recorded GraphQL answer.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toInboxIssues} from '../src/infrastructure/github/gh-inbox';

const DATA = {
    viewer: {login: 'joris'},
    repository: {
        issues: {
            pageInfo: {hasNextPage: false},
            nodes: [
                {
                    number: 482,
                    title: 'Export fails for teams',
                    url: 'https://github.com/movelab/connect/issues/482',
                    createdAt: '2026-11-01T09:00:00Z',
                    updatedAt: '2026-11-12T10:00:00Z',
                    repository: {nameWithOwner: 'movelab/connect'},
                    author: {login: 'ben'},
                    assignees: {nodes: [{login: 'joris'}]},
                    labels: {nodes: [{name: 'bug', color: 'd73a4a'}]},
                    parent: null,
                    subIssuesSummary: {total: 0},
                    comments: {totalCount: 3, nodes: [{author: {login: 'peter'}}]},
                    timelineItems: {totalCount: 1},
                },
                {
                    number: 483,
                    title: 'Sub-ticket',
                    url: 'https://github.com/movelab/connect/issues/483',
                    createdAt: '2026-11-02T09:00:00Z',
                    updatedAt: '2026-11-11T10:00:00Z',
                    repository: {nameWithOwner: 'movelab/connect'},
                    author: null,
                    assignees: {nodes: []},
                    labels: {nodes: []},
                    parent: {number: 400, repository: {nameWithOwner: 'movelab/connect'}},
                    subIssuesSummary: {total: 0},
                    comments: {totalCount: 0, nodes: []},
                    timelineItems: {totalCount: 0},
                },
            ],
        },
    },
};

test('each open issue comes with what the inbox lists and wakes on', () => {
    /* When */
    const answer = toInboxIssues(DATA, 'movelab/connect')!;

    /* Then */
    assert.equal(answer.viewer, 'joris');
    assert.equal(answer.complete, true);
    assert.deepEqual(answer.issues[0], {
        kind: 'issue',
        repository: 'movelab/connect',
        number: 482,
        title: 'Export fails for teams',
        url: 'https://github.com/movelab/connect/issues/482',
        author: 'ben',
        assignees: ['joris'],
        labels: [{name: 'bug', color: 'd73a4a'}],
        createdAt: '2026-11-01T09:00:00Z',
        updatedAt: '2026-11-12T10:00:00Z',
        comments: 3,
        lastCommentBy: 'peter',
        references: 1,
        parent: null,
        subIssues: 0,
    });
});

test('a deleted author, no comments and a parent read as such', () => {
    /* When */
    const issue = toInboxIssues(DATA, 'movelab/connect')!.issues[1]!;

    /* Then */
    assert.equal(issue.author, null);
    assert.equal(issue.lastCommentBy, null);
    assert.deepEqual(issue.parent, {repository: 'movelab/connect', number: 400});
});

test('a repository with more open issues than one page is not complete', () => {
    /* Given */
    const data = {...DATA, repository: {issues: {...DATA.repository.issues, pageInfo: {hasNextPage: true}}}};

    /* When */
    const answer = toInboxIssues(data, 'movelab/connect')!;

    /* Then */
    assert.equal(answer.complete, false);
});

test('an answer without the repository is no answer', () => {
    /* When */
    const answer = toInboxIssues({viewer: {login: 'joris'}, repository: null}, 'movelab/connect');

    /* Then */
    assert.equal(answer, null);
});
