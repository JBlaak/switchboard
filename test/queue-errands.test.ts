import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    errandState,
    fixAction,
    fixPrompt,
    nudgeMessage,
    nudgePrompt,
    type ErrandFacts,
    type FixPromptRequest,
} from '../src/domain/project/queue-errands';
import {ARCHIVE_TOOL_QUALIFIED_NAME} from '../src/domain/session/archive-tool';
import type {ReviewThread} from '../src/domain/session-work/model';

const PR = {number: 2270, title: 'Faster sync', url: 'https://github.com/o/app/pull/2270'};
const WORKTREE = '/code/app/.claude/worktrees/faster-sync';

function fixRequest(fields: Partial<FixPromptRequest['failure']> = {}, errand = true): FixPromptRequest {
    return {
        pr: {number: PR.number, url: PR.url, headRef: 'faster-sync', baseRef: 'main'},
        failure: {
            kind: 'ci',
            reason: 'Required check test failed',
            checkName: 'test',
            sha: 'abc123',
            logTail: 'Error: expected 2, got 3',
            threads: [],
            ...fields,
        },
        worktree: WORKTREE,
        errand,
    };
}

function thread(id: string, resolved = false): ReviewThread {
    return {
        id,
        path: 'src/sync.ts',
        line: 12,
        side: 'RIGHT',
        resolved,
        comments: [{author: 'ann', isBot: false, body: 'Rename this', createdAt: '2026-11-01T00:00:00Z'}],
    };
}

// ── Nudge ──

test('the nudge message names the reviewer, the PR and its link', () => {
    /* Given */
    const reviewer = 'ann';

    /* When */
    const message = nudgeMessage(PR, reviewer);

    /* Then */
    assert.equal(
        message,
        "Hey ann, could you review #2270 Faster sync? It's waiting on your review to get through the merge queue. https://github.com/o/app/pull/2270",
    );
});

test('the nudge prompt finds the reviewer on Slack, sends the exact message, and archives', () => {
    /* Given */
    const message = nudgeMessage(PR, 'ann');

    /* When */
    const prompt = nudgePrompt('ann', message);

    /* Then */
    assert.match(prompt, /GitHub user ann/);
    assert.match(prompt, /Slack MCP tools/);
    assert.ok(prompt.includes('\n\n' + message + '\n\n'), 'the message stands on its own, word for word');
    assert.match(prompt, /cannot tell for sure .* send nothing, say why in one line, and stop: do not archive/);
    assert.ok(prompt.endsWith(`call the ${ARCHIVE_TOOL_QUALIFIED_NAME} tool to archive this session.`));
});

// ── Fix in session ──

test("a CI failure's fix prompt carries the reason, the check, its commit and its log, in Fix CI's form", () => {
    /* Given */
    const request = fixRequest();

    /* When */
    const prompt = fixPrompt(request);

    /* Then */
    assert.ok(
        prompt.startsWith(
            'The merge queue took PR #2270 (https://github.com/o/app/pull/2270) out of the queue: Required check test failed\n',
        ),
    );
    assert.ok(
        prompt.includes(
            `CI is failing on PR #2270 (${PR.url}): test failed on abc123. Log tail:\nError: expected 2, got 3\nFix it in ${WORKTREE} and push.`,
        ),
    );
});

test('a new fix session pushes to the branch only, never merges, leaves the labels, and archives once pushed', () => {
    /* Given */
    const request = fixRequest();

    /* When */
    const prompt = fixPrompt(request);

    /* Then */
    assert.match(prompt, /First bring it up to date with origin\/faster-sync/);
    assert.match(prompt, /Push to faster-sync only \(git push origin HEAD:faster-sync\), and never merge the PR\./);
    assert.match(prompt, /Do not add or remove any merge-queue label/);
    assert.match(prompt, /the new commit is what puts it back in the queue/);
    assert.ok(
        prompt.endsWith(
            `Once the fix is pushed, call the ${ARCHIVE_TOOL_QUALIFIED_NAME} tool to archive this session. ` +
                'If you are stuck, or the fix needs a decision from me, say why in one line and do not archive.',
        ),
    );
});

test("the PR's own session is never told to archive", () => {
    /* Given */
    const request = fixRequest({}, false);

    /* When */
    const prompt = fixPrompt(request);

    /* Then */
    assert.ok(!prompt.includes(ARCHIVE_TOOL_QUALIFIED_NAME));
    assert.ok(!prompt.includes('First bring it up to date'));
    assert.ok(
        prompt.endsWith('If you are stuck, or the fix needs a decision from me, stop and tell me why in one line.'),
    );
});

test('a CI failure without a log or a commit says where to read it', () => {
    /* Given */
    const request = fixRequest({checkName: null, sha: null, logTail: null});

    /* When */
    const prompt = fixPrompt(request);

    /* Then */
    assert.ok(
        prompt.includes(
            'a required check failed on the head commit. Log tail:\n(no log available; read it with gh run view)',
        ),
    );
});

test('a conflict is rebased onto the base branch', () => {
    /* Given */
    const request = fixRequest({kind: 'conflict', reason: 'Conflicts with main'});

    /* When */
    const prompt = fixPrompt(request);

    /* Then */
    assert.ok(
        prompt.includes(
            `Rebase PR #2270 (faster-sync) onto origin/main and force-push with lease. Resolve conflicts if there are any; if a conflict needs a decision from me, stop and ask. Work in ${WORKTREE}.`,
        ),
    );
});

test('requested changes hand over the open review threads, in Fix comments form', () => {
    /* Given */
    const request = fixRequest({
        kind: 'changes-requested',
        reason: 'Changes requested',
        threads: [thread('T1'), thread('T2', true)],
    });

    /* When */
    const prompt = fixPrompt(request);

    /* Then */
    assert.ok(
        prompt.includes(
            `Address the open review threads on PR #2270 (${PR.url}):\nsrc/sync.ts:12 — ann: Rename this (T1)\n`,
        ),
    );
    assert.ok(!prompt.includes('(T2)'));
});

test('an unresolved thread with no threads known says to read the review', () => {
    /* Given */
    const request = fixRequest({kind: 'unresolved-thread', reason: 'Has an unresolved thread'});

    /* When */
    const prompt = fixPrompt(request);

    /* Then */
    assert.ok(
        prompt.includes(
            `Read the review on PR #2270 with gh pr view 2270 --comments, address what it asks for in ${WORKTREE}, and push.`,
        ),
    );
});

test('a refused merge says to find out why', () => {
    /* Given */
    const request = fixRequest({kind: 'merge-refused', reason: 'GitHub refused the merge'});

    /* When */
    const prompt = fixPrompt(request);

    /* Then */
    assert.ok(
        prompt.includes(`Find out why with gh pr view 2270 and gh pr checks 2270, fix it in ${WORKTREE}, and push.`),
    );
});

test("a fix shows on the owner's page as the work it is", () => {
    /* Given */
    const kinds = ['ci', 'conflict', 'changes-requested', 'unresolved-thread', 'merge-refused', 'other'] as const;

    /* When */
    const actions = kinds.map(fixAction);

    /* Then */
    assert.deepEqual(actions, ['fix-ci', 'rebase', 'fix-comments', 'fix-comments', 'fix-ci', 'fix-ci']);
});

// ── How far an errand got ──

const RUNNING: ErrandFacts = {
    started: true,
    archived: false,
    running: true,
    busy: true,
    archiveRequested: false,
    stoppedWithoutArchive: false,
};

test('an errand needs you once a turn ended without asking to be archived and it is at its prompt', () => {
    /* Given */
    const stopped = {...RUNNING, busy: false, stoppedWithoutArchive: true};

    /* When */
    const states = [
        errandState({...RUNNING, started: false}),
        errandState(RUNNING),
        errandState(stopped),
        errandState({...stopped, busy: true}),
        errandState({...stopped, archiveRequested: true}),
        errandState({...RUNNING, running: false}),
        errandState({...RUNNING, running: false, archived: true}),
    ];

    /* Then */
    assert.deepEqual(states, ['starting', 'running', 'needs-you', 'running', 'running', 'needs-you', 'done']);
});
