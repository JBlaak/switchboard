/**
 * Which issues the Issue manager lists (#413): loose ones, unassigned or yours.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assignableTo, looseIssues} from '../src/domain/inbox/loose-issues';
import {ME, REPO, issueRead} from './support/inbox-fixtures';

const numbers = (issues: {number: number}[]): number[] => issues.map((issue) => issue.number);

test('issues with a parent or sub-issues are not loose', () => {
    /* Given */
    const issues = [
        issueRead(1),
        issueRead(2, {parent: {repository: REPO, number: 9}}),
        issueRead(3, {subIssues: 4}),
        issueRead(4, {parent: {repository: 'movelab/elsewhere', number: 1}}),
    ];

    /* When */
    const loose = looseIssues(REPO, {viewer: ME, issues, complete: true});

    /* Then: a parent in another repository still puts it in a plan */
    assert.deepEqual(numbers(loose), [1]);
});

test('a standalone ready-for-agent issue is a plan, not loose', () => {
    /* Given */
    const issues = [issueRead(1, {labels: [{name: 'ready-for-agent', color: '00ff00'}]}), issueRead(2)];

    /* When */
    const loose = looseIssues(REPO, {viewer: ME, issues, complete: true});

    /* Then */
    assert.deepEqual(numbers(loose), [2]);
});

test('unassigned issues and yours are listed, others assigned elsewhere are not', () => {
    /* Given */
    const issues = [
        issueRead(1),
        issueRead(2, {assignees: [ME]}),
        issueRead(3, {assignees: ['colleague']}),
        issueRead(4, {assignees: ['colleague', ME]}),
        issueRead(5, {author: ME}),
    ];

    /* When */
    const loose = looseIssues(REPO, {viewer: ME, issues, complete: true});

    /* Then: the ones you opened are listed like any other */
    assert.deepEqual(numbers(loose).sort(), [1, 2, 4, 5]);
});

test('without a viewer only unassigned issues are listed', () => {
    /* When */
    const yours = assignableTo({assignees: [ME]}, null);
    const nobodys = assignableTo({assignees: []}, null);

    /* Then */
    assert.deepEqual([yours, nobodys], [false, true]);
});

test('loose issues come as facts, newest update first', () => {
    /* Given */
    const issues = [
        issueRead(1, {updatedAt: '2026-11-01T00:00:00Z'}),
        issueRead(2, {updatedAt: '2026-11-12T00:00:00Z'}),
    ];

    /* When */
    const loose = looseIssues(REPO, {viewer: ME, issues, complete: true});

    /* Then */
    assert.deepEqual(numbers(loose), [2, 1]);
    assert.equal(loose[0]!.kind, 'issue');
    assert.equal('parent' in loose[0]!, false);
});
