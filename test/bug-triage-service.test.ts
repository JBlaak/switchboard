/**
 * Quick triage's service (T) against fake ports: an in-memory inbox, git
 * that records what it was asked, and sessions and an archive that record
 * their calls.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BugTriageService} from '../src/application/services/bug-triage-service';
import {syncSource} from '../src/domain/inbox/items';
import {triageAllowRules} from '../src/domain/inbox/triage';
import type {BugsnagSettings} from '../src/domain/bugsnag/connection';
import type {InboxItem, InboxState} from '../src/domain/inbox/model';
import type {SessionOptions} from '../src/domain/launch/session-options';
import {DAY, NOW, PROJECT, THRESHOLDS, bug} from './support/inbox-fixtures';
import {FakeStartGit, silentLog} from './support/fakes';

const ROOT = '/code/connect';
const ERROR = '5f2a91c0deadbeef00000001';
const KEY = `bug:${PROJECT}:${ERROR}`;
const WORKTREE = `${ROOT}/.claude/worktrees/triage/bugsnag-5f2a91c0`;
const REPO = 'movelab/connect';

const VERDICT = {
    happened: 'It crashed.',
    why: 'A null.',
    where: 'src/a.ts:3',
    impact: 'Few users.',
    suggestion: 'snooze',
    summary: 'Transient.',
    confidence: 'medium',
};

function harness({linked = ROOT as string | null, startFails = false, state = null as InboxState | null} = {}) {
    const items = new Map<string, InboxItem>();
    const [first] = syncSource([], [bug(ERROR)], {
        now: NOW,
        complete: true,
        watchingSince: NOW - 30 * DAY,
        thresholds: THRESHOLDS,
        viewer: null,
    }).items;
    items.set(first!.key, state ? {...first!, state} : first!);
    const updates: string[] = [];
    const started: Array<{sessionId: string; worktree: string; options: SessionOptions}> = [];
    const archived: string[] = [];
    const world = {now: NOW};
    let id = 0;
    const settings: BugsnagSettings = {
        projects: [{id: PROJECT, name: 'Connect API', optedIn: true, localProject: linked}],
        trending: THRESHOLDS,
    };
    const git = new FakeStartGit(ROOT);
    const service = new BugTriageService({
        inbox: {
            item: (key) => items.get(key) ?? null,
            list: () => [...items.values()],
            update: (key, apply) => {
                const before = items.get(key);
                if (!before) return null;
                const after = apply(before);
                if (after !== before) updates.push(key);
                items.set(key, after);
                return after;
            },
        },
        bugsnag: {settings: () => settings},
        git: git.port,
        remotes: {originUrl: async () => `git@github.com:${REPO}.git`},
        detail: async () => ({url: 'https://app.bugsnag.com/e', frames: [{line: 'app/A.php:1  a()', inProject: true}]}),
        sessions: {
            start: async (request) => {
                // The triage is kept before the session starts.
                assert.equal(items.get(KEY)?.triage?.sessionId, request.sessionId);
                started.push(request);
                return startFails ? {ok: false, reason: 'claude is missing'} : {ok: true};
            },
        },
        archive: {
            request: (launchId) => {
                archived.push(launchId);
                return {ok: true, message: 'Archived when this turn ends.'};
            },
        },
        ids: {newId: () => `session-${++id}`},
        clock: {now: () => world.now},
        log: silentLog,
    });
    const item = (): InboxItem => items.get(KEY)!;
    return {service, item, git, started, archived, updates, world};
}

// ── Start ──

test('T starts a read-only auto session in a fresh detached worktree at the fetched default branch', async () => {
    /* Given */
    const h = harness();

    /* When */
    const result = await h.service.start(KEY);

    /* Then */
    assert.ok(result.ok);
    assert.deepEqual(h.git.writes, ['fetch main', 'worktree prune', `worktree add --detach ${WORKTREE} origin/main`]);
    assert.equal(h.started.length, 1);
    const [session] = h.started;
    assert.equal(session.sessionId, 'session-1');
    assert.equal(session.worktree, WORKTREE);
    assert.equal(session.options.permissionMode, 'auto');
    assert.deepEqual(session.options.allowedTools, triageAllowRules());
    assert.match(session.options.initialPrompt ?? '', /read-only/);
    assert.match(session.options.initialPrompt ?? '', /app\/A.php:1/);
    assert.deepEqual(result.item.triage, {
        sessionId: 'session-1',
        currentId: 'session-1',
        worktree: WORKTREE,
        repository: REPO,
        startedAt: NOW,
        verdict: null,
        stoppedAt: null,
    });
    assert.ok(h.service.isTriage('session-1'));
    assert.ok(!h.service.isTriage('someone-else'));
});

test('T on a bug with a triage running answers it as it is, and starts nothing', async () => {
    /* Given */
    const h = harness();
    await h.service.start(KEY);

    /* When */
    const again = await h.service.start(KEY);

    /* Then */
    assert.ok(again.ok);
    assert.equal(again.item.triage?.sessionId, 'session-1');
    assert.equal(h.started.length, 1);
});

test('Triage again after a verdict removes the old worktree and makes it afresh', async () => {
    /* Given */
    const h = harness();
    await h.service.start(KEY);
    h.service.finish('session-1', VERDICT);
    h.git.checkouts = [{path: WORKTREE} as never];
    h.git.writes.length = 0;

    /* When */
    const again = await h.service.start(KEY);

    /* Then */
    assert.ok(again.ok);
    assert.equal(again.item.triage?.sessionId, 'session-2');
    assert.equal(again.item.triage?.verdict, null);
    assert.deepEqual(h.git.writes, [
        'fetch main',
        `worktree remove ${WORKTREE}`,
        `worktree add --detach ${WORKTREE} origin/main`,
    ]);
});

test('offline, the worktree is made at the last origin branch known, or at HEAD without one', async () => {
    /* Given */
    const known = harness();
    known.git.unfetchable.set('main', 'no network');
    const unknown = harness();
    unknown.git.unfetchable.set('main', 'no network');
    unknown.git.remoteBranches.clear();

    /* When */
    await known.service.start(KEY);
    await unknown.service.start(KEY);

    /* Then */
    assert.ok(known.git.writes.includes(`worktree add --detach ${WORKTREE} origin/main`));
    assert.ok(unknown.git.writes.includes(`worktree add --detach ${WORKTREE} HEAD`));
});

test('an unlinked project, a remote one or a missing bug starts nothing, and says why', async () => {
    /* Given */
    const unlinked = harness({linked: null});
    const remote = harness({linked: 'ssh://vm/code/connect'});

    /* When */
    const answers = [
        await unlinked.service.start(KEY),
        await remote.service.start(KEY),
        await unlinked.service.start('bug:nope:nope'),
    ];

    /* Then */
    assert.deepEqual(answers, [
        {ok: false, reason: 'Link a project first: Settings → Bug manager.'},
        {ok: false, reason: 'Triage runs on this Mac only.'},
        {ok: false, reason: 'That bug is no longer in the inbox.'},
    ]);
    assert.equal(unlinked.started.length + remote.started.length, 0);
    assert.equal(unlinked.item().triage, undefined);
});

test('a session that does not start leaves the triage stopped and says why', async () => {
    /* Given */
    const h = harness({startFails: true});

    /* When */
    const result = await h.service.start(KEY);

    /* Then */
    assert.deepEqual(result, {ok: false, reason: 'The triage did not start: claude is missing'});
    assert.equal(h.item().triage?.stoppedAt, NOW);
});

// ── Finish ──

test('finish_triage keeps the verdict, turns a read bug unread and asks for the archive', async () => {
    /* Given */
    const h = harness({state: {kind: 'read'}});
    await h.service.start(KEY);
    h.world.now = NOW + 60_000;

    /* When */
    const outcome = h.service.finish('session-1', {...VERDICT, happened: '  It crashed.  '});

    /* Then */
    assert.ok(outcome.ok);
    assert.match(outcome.message, /^Recorded: snooze\. Archived when this turn ends\./);
    assert.deepEqual(h.item().triage?.verdict, {...VERDICT, at: NOW + 60_000});
    assert.deepEqual(h.item().state, {kind: 'unread'});
    assert.deepEqual(h.archived, ['session-1']);
    assert.ok(!h.service.isTriage('session-1'));
});

test('finish_triage leaves a snoozed bug snoozed', async () => {
    /* Given */
    const h = harness({state: {kind: 'snoozed', until: null}});
    await h.service.start(KEY);

    /* When */
    h.service.finish('session-1', VERDICT);

    /* Then */
    assert.deepEqual(h.item().state, {kind: 'snoozed', until: null});
});

test('finish_triage from another session, or with bad input, records nothing', async () => {
    /* Given */
    const h = harness();
    await h.service.start(KEY);

    /* When */
    const stranger = h.service.finish('stranger', VERDICT);
    const bad = h.service.finish('session-1', {...VERDICT, suggestion: 'panic'});

    /* Then */
    assert.equal(stranger.ok, false);
    assert.equal(bad.ok, false);
    assert.equal(h.item().triage?.verdict, null);
    assert.deepEqual(h.archived, []);
});

// ── Stopped ──

test('a turn that ends without finish_triage stops it, under its new id, and a later finish still lands', async () => {
    /* Given */
    const h = harness();
    await h.service.start(KEY);
    h.world.now = NOW + 5_000;

    /* When */
    h.service.turnEnded(['session-1', 'real-1'], false, 'real-1');
    const stopped = h.item().triage;
    const late = h.service.finish('real-1', VERDICT);

    /* Then */
    assert.equal(stopped?.currentId, 'real-1');
    assert.equal(stopped?.stoppedAt, NOW + 5_000);
    assert.ok(late.ok);
    assert.equal(h.item().triage?.stoppedAt, null);
    assert.equal(h.item().triage?.verdict?.suggestion, 'snooze');
});

test('a turn that ends archiving does not stop it; the session ending after does', async () => {
    /* Given */
    const h = harness();
    await h.service.start(KEY);

    /* When */
    h.service.turnEnded(['session-1'], true, 'session-1');
    const afterTurn = h.item().triage?.stoppedAt;
    h.service.sessionEnded('session-1');

    /* Then */
    assert.equal(afterTurn, null);
    assert.equal(h.item().triage?.stoppedAt, NOW);
});

test('a session waiting on you stops its triage; a finished triage is never stopped', async () => {
    /* Given */
    const waiting = harness();
    await waiting.service.start(KEY);
    const finished = harness();
    await finished.service.start(KEY);
    finished.service.finish('session-1', VERDICT);

    /* When */
    waiting.service.needsAttention('session-1');
    finished.service.sessionEnded('session-1');
    finished.service.turnEnded(['session-1'], false, 'session-1');

    /* Then */
    assert.equal(waiting.item().triage?.stoppedAt, NOW);
    assert.equal(finished.item().triage?.stoppedAt, null);
});
