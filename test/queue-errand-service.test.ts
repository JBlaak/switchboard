import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    ERRAND_START_TIMEOUT_MS,
    QueueErrandService,
    type ErrandOwnerCandidate,
} from '../src/application/services/queue-errand-service';
import {SessionActionService} from '../src/application/services/session-action-service';
import {nudgeMessage, type FixRequest, type QueueErrand} from '../src/domain/project/queue-errands';
import {ARCHIVE_TOOL_QUALIFIED_NAME} from '../src/domain/session/archive-tool';
import type {QueueErrandStore} from '../src/application/ports/queue-errand-store';
import type {GitHubWrite} from '../src/application/ports/github-cli';
import type {PullRequestStatus} from '../src/domain/session-work/model';
import type {TranscriptLocation} from '../src/application/ports/transcript-store';
import {FakeStartGit, silentLog} from './support/fakes';
import {FakePrompter, MemoryStore} from './support/session-work-fakes';

const REPO = 'o/app';
const ROOT = '/code/app';
const PR = {number: 2270, title: 'Faster sync', url: 'https://github.com/o/app/pull/2270'};
const RUN_URL = 'https://github.com/o/app/actions/runs/9/job/77';

class MemoryErrandStore implements QueueErrandStore {
    public rows: QueueErrand[] = [];
    public add(errand: QueueErrand) {
        this.rows.push({...errand});
    }
    public setSession(id: string, sessionId: string) {
        const row = this.rows.find((r) => r.id === id);
        if (row) row.sessionId = sessionId;
    }
    public settle(id: string, at: number) {
        const row = this.rows.find((r) => r.id === id);
        if (row) row.settledAt = at;
    }
    public remove(id: string) {
        this.rows = this.rows.filter((r) => r.id !== id);
    }
    public all() {
        return this.rows.map((r) => ({...r}));
    }
}

function status(fields: Partial<PullRequestStatus> = {}): PullRequestStatus {
    return {
        number: PR.number,
        url: PR.url,
        repository: REPO,
        state: 'open',
        headRef: 'faster-sync',
        baseRef: 'main',
        headSha: 'abc123',
        checks: [
            {name: 'lint', state: 'passing'},
            {name: 'test', state: 'failing', url: RUN_URL},
        ],
        closes: [],
        ...fields,
    };
}

function harness({
    running = [] as ErrandOwnerCandidate[],
    locations = {} as Record<string, TranscriptLocation[]>,
    prs = [status()] as PullRequestStatus[] | null,
} = {}) {
    const store = new MemoryErrandStore();
    const prompter = new FakePrompter();
    prompter.running.clear();
    const git = new FakeStartGit(ROOT);
    git.remoteBranches.add('faster-sync');
    const now = {value: Date.UTC(2026, 10, 4, 12)};
    let seq = 0;
    const ids = {newId: () => 'id' + ++seq};
    const actionStore = new MemoryStore();
    const actions = new SessionActionService({
        prompter,
        store: actionStore,
        github: {checkLogTail: async () => null},
        ids,
        clock: {now: () => now.value},
        log: silentLog,
    });
    const labelWrites: string[] = [];
    const logRequests: string[] = [];
    const archiveRequested = new Set<string>();
    const archived = new Set<string>();
    const labelAnswer: {value: GitHubWrite} = {value: {ok: true}};
    const write = async (what: string): Promise<GitHubWrite> => {
        labelWrites.push(what);
        return labelAnswer.value;
    };
    const service = new QueueErrandService({
        running: () => running,
        sessions: () => [],
        store,
        actions,
        github: {
            pullRequests: async () => prs,
            checkLogTail: async (repo, url, lines) => {
                logRequests.push(`${repo} ${url} ${lines}`);
                return 'Error: expected 2, got 3';
            },
        },
        labels: {
            addLabel: (repo, number, label) => write(`add ${repo}#${number} ${label}`),
            removeLabel: (repo, number, label) => write(`remove ${repo}#${number} ${label}`),
        },
        git: {...git.port, worktreeRoot: async (cwd) => cwd},
        transcripts: {locations: (_folder, sessionId) => locations[sessionId] ?? []},
        prompter,
        archiveRequested: (sessionId) => archiveRequested.has(sessionId),
        archived: (sessionId) => archived.has(sessionId),
        ids,
        clock: {now: () => now.value},
        log: silentLog,
    });
    return {
        service,
        store,
        prompter,
        git,
        now,
        actionStore,
        labelWrites,
        labelAnswer,
        logRequests,
        archiveRequested,
        archived,
    };
}

function nudgeRequest(reviewer = 'ann') {
    return {repository: REPO, pr: PR, reviewer, message: nudgeMessage(PR, reviewer)};
}

function fixRequest(fields: Partial<FixRequest> = {}): FixRequest {
    return {
        repository: REPO,
        projectPath: ROOT,
        pr: {...PR, headRef: 'faster-sync'},
        failure: {kind: 'ci', reason: 'Required check test failed', checkName: 'test'},
        ...fields,
    };
}

function owner(sessionId: string, url = PR.url): ErrandOwnerCandidate {
    return {
        sessionId,
        projectPath: ROOT,
        folder: 'folder-' + sessionId,
        pullRequests: [{number: Number(url.split('/').pop()), url, repository: REPO}],
    };
}

// ── Retry and Opt in ──

test('Retry removes automerge:failed and Opt in adds automerge:opt-in, and nothing else', async () => {
    /* Given */
    const {service, labelWrites} = harness();

    /* When */
    const retried = await service.retry(REPO, 2270);
    const optedIn = await service.optIn(REPO, 2271);

    /* Then */
    assert.deepEqual([retried, optedIn], [{ok: true}, {ok: true}]);
    assert.deepEqual(labelWrites, ['remove o/app#2270 automerge:failed', 'add o/app#2271 automerge:opt-in']);
});

test('Retry on a PR the queue already took automerge:failed off is fine', async () => {
    /* Given */
    const {service, labelAnswer} = harness();
    labelAnswer.value = {ok: false, reason: 'Label does not exist'};

    /* When */
    const retried = await service.retry(REPO, 2270);

    /* Then */
    assert.deepEqual(retried, {ok: true});
});

test('Retry reports any other failure to write the label', async () => {
    /* Given */
    const {service, labelAnswer} = harness();
    labelAnswer.value = {ok: false, reason: 'gh is not signed in'};

    /* When */
    const retried = await service.retry(REPO, 2270);

    /* Then */
    assert.deepEqual(retried, {ok: false, reason: 'gh is not signed in'});
});

// ── Nudge ──

test('a nudge answers its prompt with the exact message, and is remembered as an errand', () => {
    /* Given */
    const {service, store} = harness();

    /* When */
    const result = service.nudge(nudgeRequest());

    /* Then */
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.errandId, 'id1');
    assert.ok(result.prompt.includes(nudgeMessage(PR, 'ann')));
    assert.ok(result.prompt.includes(ARCHIVE_TOOL_QUALIFIED_NAME));
    assert.deepEqual(
        store.rows.map(({kind, repository, number, reviewer, sessionId}) => ({
            kind,
            repository,
            number,
            reviewer,
            sessionId,
        })),
        [{kind: 'nudge', repository: REPO, number: 2270, reviewer: 'ann', sessionId: null}],
    );
});

test('a second nudge for the same PR and reviewer is refused', () => {
    /* Given */
    const {service} = harness();
    const first = service.nudge(nudgeRequest());
    if (first.ok) service.started(first.errandId, 'nudge-session');

    /* When */
    const second = service.nudge(nudgeRequest());
    const otherReviewer = service.nudge(nudgeRequest('bob'));

    /* Then */
    assert.deepEqual(second, {ok: false, reason: 'ann was already nudged about #2270'});
    assert.equal(otherReviewer.ok, true);
});

test('a message other than the one the confirm showed is refused', () => {
    /* Given */
    const {service, store} = harness();

    /* When */
    const result = service.nudge({...nudgeRequest(), message: 'Hey ann, merge it already'});

    /* Then */
    assert.equal(result.ok, false);
    assert.deepEqual(store.rows, []);
});

test('once the review request changes, the reviewer may be nudged again', () => {
    /* Given */
    const {service} = harness();
    service.nudge(nudgeRequest('ann'));
    service.nudge(nudgeRequest('bob'));

    /* When */
    service.forgetNudge(REPO, 2270, 'ann');
    service.settleNudges(REPO, [{number: 2270, reviewer: 'ann'}]);
    const again = service.nudge(nudgeRequest('ann'));
    const bob = service.nudge(nudgeRequest('bob'));
    service.settleNudges(REPO, []);
    const bobLater = service.nudge(nudgeRequest('bob'));

    /* Then */
    assert.equal(again.ok, true, 'forgotten by hand');
    assert.equal(bob.ok, true, 'settled: no longer held for bob');
    assert.equal(bobLater.ok, true, 'settled again');
});

test('a nudge whose session could not start is forgotten, and may be asked for again', () => {
    /* Given */
    const {service} = harness();
    const first = service.nudge(nudgeRequest());
    assert.ok(first.ok);

    /* When */
    const abandoned = service.abandon(first.errandId);
    const again = service.nudge(nudgeRequest());

    /* Then */
    assert.deepEqual(abandoned, {ok: true});
    assert.equal(again.ok, true);
});

test('a nudge whose session was never reported started is dropped after a while', () => {
    /* Given */
    const {service, now} = harness();
    service.nudge(nudgeRequest());

    /* When */
    now.value += ERRAND_START_TIMEOUT_MS + 1;
    const again = service.nudge(nudgeRequest());

    /* Then */
    assert.equal(again.ok, true);
});

// ── Fix in session ──

test("a fix goes to the running owner session's action queue, in the worktree it worked on the branch in, not told to archive", async () => {
    /* Given */
    const worktree = ROOT + '/.claude/worktrees/faster-sync';
    const {service, prompter, actionStore, git, logRequests} = harness({
        running: [owner('other', 'https://github.com/o/app/pull/1'), owner('s1')],
        locations: {s1: [{cwd: worktree, branch: 'faster-sync', fromSubagent: false}]},
    });
    prompter.running.add('s1');

    /* When */
    const result = await service.fix(fixRequest());

    /* Then */
    assert.deepEqual(result, {ok: true, kind: 'queued', sessionId: 's1', activityId: 'id1'});
    assert.deepEqual(
        actionStore.rows.map(({sessionId, itemKey, action, details}) => ({sessionId, itemKey, action, details})),
        [{sessionId: 's1', itemKey: 'pr:' + PR.url, action: 'fix-ci', details: {checkName: 'test'}}],
    );
    const prompt = prompter.sent[0]?.prompt ?? '';
    assert.match(prompt, /out of the queue: Required check test failed/);
    assert.match(
        prompt,
        new RegExp(`test failed on abc123\\. Log tail:\\nError: expected 2, got 3\\nFix it in ${worktree} and push\\.`),
    );
    assert.ok(!prompt.includes(ARCHIVE_TOOL_QUALIFIED_NAME));
    assert.deepEqual(logRequests, [`o/app ${RUN_URL} 80`]);
    assert.deepEqual(git.writes, [], 'no worktree made');
});

test('with no running owner, a fix prepares a worktree on the PR branch with the fix prompt, as an errand', async () => {
    /* Given */
    const {service, git, store} = harness();

    /* When */
    const result = await service.fix(fixRequest());

    /* Then */
    const worktree = ROOT + '/.claude/worktrees/faster-sync';
    assert.equal(result.ok, true);
    if (!result.ok || result.kind !== 'start') return assert.fail('expected a session to start');
    assert.equal(result.worktreePath, worktree);
    assert.equal(result.branch, 'faster-sync');
    assert.deepEqual(git.writes, ['fetch faster-sync', `worktree add -b faster-sync ${worktree} origin/faster-sync`]);
    assert.match(result.prompt, /out of the queue: Required check test failed/);
    assert.match(result.prompt, /test failed on abc123\. Log tail:\nError: expected 2, got 3\n/);
    assert.match(result.prompt, /Push to faster-sync only/);
    assert.ok(result.prompt.includes(ARCHIVE_TOOL_QUALIFIED_NAME));
    assert.deepEqual(
        store.rows.map(({id, kind, number}) => ({id, kind, number})),
        [{id: result.errandId, kind: 'fix', number: 2270}],
    );
});

test('a branch checked out already is continued in its worktree', async () => {
    /* Given */
    const {service, git} = harness();
    const existing = ROOT + '/.claude/worktrees/sync';
    git.branches.add('faster-sync');
    git.checkouts = [
        {
            path: existing,
            branch: 'faster-sync',
            main: false,
            locked: false,
            changedFiles: 0,
            ahead: 0,
            merged: false,
            lastCommitAt: null,
        },
    ];

    /* When */
    const result = await service.fix(fixRequest());

    /* Then */
    assert.equal(result.ok && result.kind === 'start' && result.worktreePath, existing);
    assert.deepEqual(git.writes, ['fetch faster-sync']);
});

test('a branch that is neither on origin nor here is refused', async () => {
    /* Given */
    const {service, git} = harness();
    git.remoteBranches.delete('faster-sync');
    git.unfetchable.set('faster-sync', "couldn't find remote ref");

    /* When */
    const result = await service.fix(fixRequest());

    /* Then */
    assert.deepEqual(result, {ok: false, reason: "Could not fetch faster-sync: couldn't find remote ref"});
});

test('a second fix for a PR whose fix session is running is refused', async () => {
    /* Given */
    const {service, prompter} = harness();
    const first = await service.fix(fixRequest());
    if (!first.ok || first.kind !== 'start') return assert.fail('expected a session to start');
    service.started(first.errandId, 'fix-session');
    prompter.running.add('fix-session');

    /* When */
    const second = await service.fix(fixRequest());

    /* Then */
    assert.deepEqual(second, {ok: false, reason: 'A fix session for #2270 is already running'});
});

test('a conflict fix carries the rebase, and requested changes the open threads', async () => {
    /* Given */
    const {service} = harness({
        prs: [
            status(),
            status({
                number: 2271,
                threads: [
                    {
                        id: 'T1',
                        path: 'a.ts',
                        line: 3,
                        side: 'RIGHT',
                        resolved: false,
                        comments: [{author: 'ann', isBot: false, body: 'Rename', createdAt: '2026-11-01T00:00:00Z'}],
                    },
                ],
            }),
        ],
    });

    /* When */
    const conflict = await service.fix(
        fixRequest({failure: {kind: 'conflict', reason: 'Conflicts with main', checkName: null}}),
    );
    const changes = await service.fix(
        fixRequest({
            pr: {...PR, number: 2271, url: 'https://github.com/o/app/pull/2271', headRef: 'faster-sync'},
            failure: {kind: 'changes-requested', reason: 'Changes requested', checkName: null},
        }),
    );

    /* Then */
    assert.ok(conflict.ok && conflict.kind === 'start');
    assert.match(conflict.prompt, /Rebase PR #2270 \(faster-sync\) onto origin\/main and force-push with lease\./);
    assert.ok(changes.ok && changes.kind === 'start');
    assert.match(changes.prompt, /a\.ts:3 — ann: Rename \(T1\)/);
});

// ── Errands ──

test("an errand's state follows its session: starting, running, needs you, done", () => {
    /* Given */
    const {service, prompter, archiveRequested, archived} = harness();
    const nudged = service.nudge(nudgeRequest());
    assert.ok(nudged.ok);
    const state = () => service.errands(REPO)[0]?.state;
    const before = state();

    /* When */
    service.started(nudged.errandId, 'nudge-session');
    prompter.running.add('nudge-session');
    prompter.busy.add('nudge-session');
    const working = state();
    service.turnEnded(['nudge-session'], false);
    prompter.busy.delete('nudge-session');
    const stuck = state();
    archiveRequested.add('nudge-session');
    const archiving = state();
    prompter.running.delete('nudge-session');
    archived.add('nudge-session');
    const done = state();

    /* Then */
    assert.deepEqual(
        [before, working, stuck, archiving, done],
        ['starting', 'running', 'needs-you', 'running', 'done'],
    );
});

test('an errand reports the id its session goes by now', () => {
    /* Given */
    const {service, prompter} = harness();
    const nudged = service.nudge(nudgeRequest());
    assert.ok(nudged.ok);
    service.started(nudged.errandId, 'launch-id');
    prompter.running.add('forked-id');
    prompter.moved.set('launch-id', 'forked-id');

    /* When */
    const [errand] = service.errands();

    /* Then */
    assert.equal(errand.sessionId, 'forked-id');
    assert.equal(errand.state, 'running');
    assert.equal(errand.message, nudgeMessage(PR, 'ann'));
});

test("another repository's errands are left out", () => {
    /* Given */
    const {service} = harness();
    service.nudge(nudgeRequest());

    /* When */
    const errands = service.errands('o/other');

    /* Then */
    assert.deepEqual(errands, []);
});
