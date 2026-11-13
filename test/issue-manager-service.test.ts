/**
 * The Issue manager page's work in main (#415) against fake ports: GitHub's
 * thread and writes, the worktree maker, the polish call, and an inbox
 * holding a few issues.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IssueManagerService} from '../src/application/services/issue-manager-service';
import type {LooseIssueWorktreeRequest} from '../src/application/services/issue-session-service';
import type {GitHubWrite} from '../src/application/ports/github-cli';
import type {IssueThread} from '../src/domain/inbox/issue-manager';
import {finish, returnToInbox, setNotes, setStage, setWork, startWork, syncSource} from '../src/domain/inbox/items';
import type {InboxItem, InboxStage, InboxWork} from '../src/domain/inbox/model';
import type {RepositoryPullRequest} from '../src/domain/project/overview';
import {fakeTimers, silentLog} from './support/fakes';
import {ME, NOW, REPO, THRESHOLDS, issue} from './support/inbox-fixtures';

const KEY = `issue:${REPO}#482`;
const PROJECT = '/code/connect';

const THREAD: IssueThread = {
    body: 'The export button does nothing.',
    comments: [{author: 'marieke', body: 'Chrome on Windows.', createdAt: '2026-11-13T10:00:00Z'}],
    total: 1,
    viewer: ME,
};

function setup({
    assign = {ok: true},
    thread = THREAD,
    polished = 'Thanks, I will pick this up.',
    pullRequests = [] as RepositoryPullRequest[],
}: {
    assign?: GitHubWrite;
    thread?: IssueThread | null;
    polished?: string | null;
    pullRequests?: RepositoryPullRequest[];
} = {}) {
    const items = new Map<string, InboxItem>();
    for (const item of syncSource([], [issue(482, {title: 'Export on the coach page'})], {
        now: NOW,
        complete: true,
        watchingSince: NOW,
        thresholds: THRESHOLDS,
        viewer: ME,
    }).items) {
        items.set(item.key, setNotes(item, 'CSV export'));
    }
    const change = (key: string, apply: (item: InboxItem) => InboxItem): InboxItem | null => {
        const before = items.get(key);
        if (!before) return null;
        const after = apply(before);
        items.set(key, after);
        return after;
    };
    const writes: string[] = [];
    const prepared: LooseIssueWorktreeRequest[] = [];
    const calls: string[][] = [];
    const service = new IssueManagerService({
        inbox: {
            item: (key) => items.get(key) ?? null,
            list: () => [...items.values()],
            startWork: (key) => change(key, (item) => startWork(item)),
            setWork: (key, work: InboxWork | null) => change(key, (item) => setWork(item, work)),
            setStage: (key, stage: InboxStage) => change(key, (item) => setStage(item, stage)),
            finish: (key) => change(key, (item) => finish(item, NOW)),
            returnToInbox: (key) => change(key, returnToInbox),
            projectFor: async (repository) => (repository === REPO ? PROJECT : null),
        },
        github: {
            issueThread: async () => thread,
            assignSelf: async (repo, n) => {
                writes.push(`assign ${repo}#${n}`);
                return assign;
            },
            unassignSelf: async (repo, n) => {
                writes.push(`unassign ${repo}#${n}`);
                return {ok: true};
            },
            commentOnIssue: async (repo, n, body) => {
                writes.push(`comment ${repo}#${n}: ${body}`);
                return {ok: true};
            },
            pullRequestsIn: async () => pullRequests,
        },
        issueSessions: {
            prepareLooseIssueWorktree: async (request) => {
                prepared.push(request);
                return {
                    ok: true,
                    worktreePath: PROJECT + '/.claude/worktrees/482-export',
                    branch: '482-export',
                    prompt: 'Work on #482',
                };
            },
        },
        cli: {
            call: async (args) => {
                calls.push([...args]);
                return {
                    exitCode: polished ? 0 : 1,
                    stdout: JSON.stringify({type: 'result', result: polished ?? ''}),
                    stderr: '',
                };
            },
        },
        timers: fakeTimers(),
        log: silentLog,
    });
    return {service, items, writes, prepared, calls};
}

// ── Start and claim ──

test('Start claims the issue, then makes its worktree with the ticket, its thread and your notes', async () => {
    /* Given */
    const {service, writes, prepared} = setup();

    /* When */
    const result = await service.prepareStart(KEY);

    /* Then */
    assert.deepEqual(writes, [`assign ${REPO}#482`]);
    assert.deepEqual(result, {
        ok: true,
        projectPath: PROJECT,
        worktreePath: PROJECT + '/.claude/worktrees/482-export',
        branch: '482-export',
        prompt: 'Work on #482',
    });
    assert.deepEqual(prepared[0], {
        projectPath: PROJECT,
        issue: {repository: REPO, number: 482},
        ticket: {
            title: 'Export on the coach page',
            author: 'colleague',
            body: THREAD.body,
            comments: THREAD.comments,
            notes: 'CSV export',
        },
        existing: 'reuse',
    });
});

test('a claim GitHub refuses still starts, with a warning', async () => {
    /* Given */
    const {service} = setup({assign: {ok: false, reason: 'gh is not signed in to github.com'}});

    /* When */
    const result = await service.prepareStart(KEY);

    /* Then */
    assert.equal(result.ok && result.warning, 'Not assigned to you on GitHub: gh is not signed in to github.com.');
});

test('a started session puts the issue in progress, on its branch', async () => {
    /* Given */
    const {service} = setup();

    /* When */
    const item = service.started(KEY, '482-export', 'session-1');

    /* Then */
    assert.deepEqual(item?.state, {kind: 'inProgress', stage: 'working'});
    assert.deepEqual(item?.work, {branch: '482-export', sessionId: 'session-1', pullRequest: null});
});

// ── Stop working on it ──

test('Stop puts the issue back in the inbox and leaves the assignee alone unless asked', async () => {
    /* Given */
    const {service, writes} = setup();
    service.started(KEY, '482-export', 'session-1');

    /* When */
    const {item} = await service.stopWork(KEY, false);

    /* Then */
    assert.equal(item?.state.kind, 'read');
    assert.equal(item?.work, null);
    assert.deepEqual(writes, []);
});

test('Stop with unassign takes you off the issue on GitHub', async () => {
    /* Given */
    const {service, writes} = setup();
    service.started(KEY, '482-export', null);

    /* When */
    await service.stopWork(KEY, true);

    /* Then */
    assert.deepEqual(writes, [`unassign ${REPO}#482`]);
});

// ── Comments ──

test('Comment… polishes the notes with Haiku and answers the footer posting adds, writing nothing', async () => {
    /* Given */
    const {service, writes, calls} = setup();

    /* When */
    const result = await service.polish(KEY, 'will look, is it only athletes?');

    /* Then */
    assert.deepEqual(result, {
        ok: true,
        body: 'Thanks, I will pick this up.',
        footer: "— Polished with Claude from joris's notes in Switchboard",
    });
    assert.equal(calls[0]![2], 'haiku');
    assert.match(calls[0]!.at(-1)!, /<notes>\nwill look, is it only athletes\?\n<\/notes>/);
    assert.deepEqual(writes, []);
});

test('Post writes the edited preview with the footer after it', async () => {
    /* Given */
    const {service, writes} = setup();
    await service.polish(KEY, 'notes');

    /* When */
    const result = await service.post(KEY, 'Thanks, edited by me.');

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(writes, [
        `comment ${REPO}#482: Thanks, edited by me.\n\n— Polished with Claude from joris's notes in Switchboard`,
    ]);
});

test('Polish and post now posts the polished comment with the footer, and keeps the notes', async () => {
    /* Given */
    const {service, writes, items} = setup();

    /* When */
    const result = await service.polishAndPost(KEY, 'CSV export');

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(writes, [
        `comment ${REPO}#482: Thanks, I will pick this up.\n\n— Polished with Claude from joris's notes in Switchboard`,
    ]);
    assert.equal(items.get(KEY)?.notes, 'CSV export');
});

test('a polish that fails posts nothing', async () => {
    /* Given */
    const {service, writes} = setup({polished: null});

    /* When */
    const result = await service.polishAndPost(KEY, 'CSV export');

    /* Then */
    assert.deepEqual(result, {ok: false, reason: 'Claude could not polish the notes'});
    assert.deepEqual(writes, []);
});

// ── Following ──

function closing(number: number, fields: Partial<RepositoryPullRequest>): RepositoryPullRequest {
    return {
        repository: REPO,
        number,
        title: 'Fix the export',
        state: 'open',
        draft: false,
        mine: true,
        headRef: '482-export',
        updatedAt: '',
        checks: {state: 'failing', failing: 1},
        review: null,
        closes: [{repository: REPO, number: 482}],
        wait: {} as RepositoryPullRequest['wait'],
        queue: {labels: []} as unknown as RepositoryPullRequest['queue'],
        ...fields,
    };
}

test('a started issue follows the PR that closes it, and is done once it merged', async () => {
    /* Given */
    const failing = setup({pullRequests: [closing(244, {})]});
    failing.service.started(KEY, '482-export', 's');
    const merged = setup({pullRequests: [closing(244, {state: 'merged'})]});
    merged.service.started(KEY, '482-export', 's');

    /* When */
    await failing.service.follow();
    await merged.service.follow();

    /* Then */
    assert.deepEqual(failing.items.get(KEY)?.state, {kind: 'inProgress', stage: 'ciFailing'});
    assert.equal(failing.items.get(KEY)?.work?.pullRequest, 244);
    assert.deepEqual(merged.items.get(KEY)?.state, {kind: 'done', at: NOW});
    assert.equal(merged.items.get(KEY)?.work?.pullRequest, 244);
});
