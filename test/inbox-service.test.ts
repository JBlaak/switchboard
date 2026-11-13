/**
 * The managers' pollers (#413) against fake ports: Bugsnag and GitHub as
 * edited between polls, a fake clock and timers, and an in-memory store.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {INBOX_POLL_INTERVAL_MS, InboxService} from '../src/application/services/inbox-service';
import {BugsnagApiError} from '../src/application/ports/bugsnag-api';
import type {BugsnagApi, ErrorQuery} from '../src/application/ports/bugsnag-api';
import type {InboxStore} from '../src/application/ports/inbox-store';
import type {BugsnagSettings} from '../src/domain/bugsnag/connection';
import type {BugsnagError} from '../src/domain/bugsnag/model';
import type {InboxIssuesAnswer} from '../src/domain/inbox/loose-issues';
import type {InboxItem, InboxSummary} from '../src/domain/inbox/model';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {DAY, HOUR, ME, NOW, PROJECT, REPO, THRESHOLDS, bugsnagError, issueRead} from './support/inbox-fixtures';

class MemoryInboxStore implements InboxStore {
    public readonly items = new Map<string, InboxItem>();
    public readonly since = new Map<string, number>();
    public writes = 0;

    public all(): InboxItem[] {
        return [...this.items.values()];
    }

    public apply(save: readonly InboxItem[], remove: readonly string[]): void {
        this.writes++;
        for (const item of save) this.items.set(item.key, item);
        for (const key of remove) this.items.delete(key);
    }

    public watchingSince(source: string): number | null {
        return this.since.get(source) ?? null;
    }

    public setWatchingSince(source: string, at: number): void {
        this.since.set(source, at);
    }
}

const LOCAL = '/code/connect';

interface World {
    /** Open errors per Bugsnag project, with their window counts as `day` and `week`. */
    errors: Record<string, {error: BugsnagError; day?: number; week?: number}[]>;
    /** Throw for these projects, as Bugsnag being down. */
    failing: Set<string>;
    bugsnag: BugsnagSettings;
    token: boolean;
    /** The answer per repository; null as when `gh` could not be asked. */
    issues: Record<string, InboxIssuesAnswer | null>;
    /** Local projects with Watch issues on, and their repository. */
    watched: Record<string, string>;
    now: number;
}

function setup(overrides: Partial<World> = {}) {
    const world: World = {
        errors: {},
        failing: new Set(),
        bugsnag: {
            projects: [{id: PROJECT, name: 'Connect API', optedIn: true, localProject: LOCAL}],
            trending: THRESHOLDS,
        },
        token: true,
        issues: {},
        watched: {},
        now: NOW,
        ...overrides,
    };
    const asked: string[] = [];
    const api: BugsnagApi = {
        listProjects: async () => [],
        listErrors: async (projectId: string, query: ErrorQuery = {}) => {
            asked.push(
                `${projectId}${query.since ? ' since ' + (world.now - query.since.getTime()) / HOUR + 'h' : ''}`,
            );
            if (world.failing.has(projectId)) throw new BugsnagApiError('unreachable', 'down');
            const rows = world.errors[projectId] ?? [];
            const window = query.since ? (world.now - query.since.getTime() <= DAY ? 'day' : 'week') : null;
            const errors = rows
                .filter((row) => !window || (row[window] ?? 0) > 0)
                .map((row) => (window ? {...row.error, events: row[window]!} : row.error));
            return {errors, next: null, total: errors.length};
        },
        errorTrend: async () => [],
        eventsSince: async () => [],
        fix: async () => {},
        linkIssue: async () => {},
    };
    const store = new MemoryInboxStore();
    const renderer = fakeRenderer();
    const timers = fakeTimers();
    const make = () =>
        new InboxService({
            store,
            bugsnag: {api: () => (world.token ? api : null), settings: () => world.bugsnag},
            github: {inboxIssuesIn: async (repo) => world.issues[repo] ?? null},
            projects: () => [LOCAL, '/code/quiet'],
            settings: {project: (path) => (world.watched[path!] ? {watchIssues: true} : {})},
            git: {worktreeRoot: async (path) => path},
            remotes: {
                originUrl: async (root) => (world.watched[root] ? `git@github.com:${world.watched[root]}.git` : null),
            },
            renderer,
            clock: {now: () => world.now},
            timers,
            log: silentLog,
            agentlessRemote: () => false,
        });
    return {world, store, renderer, timers, asked, inbox: make(), make};
}

const states = (inbox: InboxService) => Object.fromEntries(inbox.list().map((item) => [item.key, item.state.kind]));

test("a project's first poll lists its open errors unread and counts them", async () => {
    /* Given */
    const {inbox, renderer, world} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}, {error: bugsnagError('b')}];

    /* When */
    await inbox.poll();

    /* Then */
    assert.deepEqual(states(inbox), {'bug:connect-api:a': 'unread', 'bug:connect-api:b': 'unread'});
    assert.deepEqual(inbox.summary().bug, {unread: 2, urgent: 0});
    assert.deepEqual(renderer.only('inboxChanged').at(-1), [
        'inboxChanged',
        {bug: {unread: 2, urgent: 0}, issue: {unread: 0, urgent: 0}, configured: {bug: true, issue: false}},
    ]);
});

test('each project is asked for its open errors and their last 24 h and 7 days', async () => {
    /* Given */
    const {inbox, asked} = setup();

    /* When */
    await inbox.poll();

    /* Then */
    assert.deepEqual(asked, [PROJECT, `${PROJECT} since 24h`, `${PROJECT} since 168h`]);
});

test('a spike makes the Bug manager urgent, and the bug comes back when it was read', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a'), day: 2, week: 14}];
    await inbox.poll();
    inbox.markRead('bug:connect-api:a');

    /* When */
    world.errors[PROJECT] = [{error: bugsnagError('a'), day: 40, week: 52}];
    world.now += INBOX_POLL_INTERVAL_MS;
    await inbox.poll();

    /* Then */
    assert.deepEqual(inbox.summary().bug, {unread: 1, urgent: 1});
});

test('a bug first seen after its project was first synced is new; the backlog is not', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('old')}];
    await inbox.poll();

    /* When */
    world.now += INBOX_POLL_INTERVAL_MS;
    const firstSeenUnfiltered = new Date(world.now - 60_000).toISOString();
    world.errors[PROJECT].push({error: bugsnagError('fresh', {firstSeenUnfiltered})});
    await inbox.poll();

    /* Then */
    assert.equal(inbox.item('bug:connect-api:old')!.signals!.new, false);
    assert.equal(inbox.item('bug:connect-api:fresh')!.signals!.new, true);
});

test('a fixed or ignored bug leaves the inbox', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}, {error: bugsnagError('b')}];
    await inbox.poll();

    /* When: b is no longer open */
    world.errors[PROJECT] = [{error: bugsnagError('a')}];
    await inbox.poll();

    /* Then */
    assert.deepEqual(Object.keys(states(inbox)), ['bug:connect-api:a']);
});

test('a failed fetch keeps the last state', async () => {
    /* Given */
    const {inbox, world, store} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}];
    world.issues[REPO] = {viewer: ME, issues: [issueRead(1)], complete: true};
    world.watched[LOCAL] = REPO;
    await inbox.poll();
    inbox.snooze('bug:connect-api:a', null);

    /* When: Bugsnag is down and `gh` signed out */
    world.failing.add(PROJECT);
    world.issues[REPO] = null;
    await inbox.poll();

    /* Then */
    assert.deepEqual(states(inbox), {'bug:connect-api:a': 'snoozed', 'issue:movelab/connect#1': 'unread'});
    assert.equal(store.items.size, 2);
});

test('one project failing does not stop the next', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.bugsnag = {
        ...world.bugsnag,
        projects: [
            {id: 'down', name: 'Down', optedIn: true, localProject: null},
            {id: PROJECT, name: 'Connect API', optedIn: true, localProject: LOCAL},
        ],
    };
    world.failing.add('down');
    world.errors[PROJECT] = [{error: bugsnagError('a')}];

    /* When */
    await inbox.poll();

    /* Then */
    assert.deepEqual(Object.keys(states(inbox)), ['bug:connect-api:a']);
});

test('opting a project out drops its inbox items but keeps one being worked on', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}, {error: bugsnagError('b')}];
    await inbox.poll();
    inbox.startWork('bug:connect-api:b');

    /* When */
    world.bugsnag = {...world.bugsnag, projects: [{...world.bugsnag.projects[0]!, optedIn: false}]};
    await inbox.poll();

    /* Then */
    assert.deepEqual(states(inbox), {'bug:connect-api:b': 'inProgress'});
});

test('without a token nothing is asked of Bugsnag and nothing is dropped', async () => {
    /* Given */
    const {inbox, world, asked} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}];
    await inbox.poll();
    asked.length = 0;

    /* When */
    world.token = false;
    await inbox.poll();

    /* Then */
    assert.deepEqual(asked, []);
    assert.deepEqual(Object.keys(states(inbox)), ['bug:connect-api:a']);
});

test("watched repositories' loose issues are listed, unassigned or yours", async () => {
    /* Given */
    const {inbox, world} = setup();
    world.watched[LOCAL] = REPO;
    world.issues[REPO] = {
        viewer: ME,
        issues: [issueRead(1), issueRead(2, {assignees: ['colleague']}), issueRead(3, {subIssues: 2})],
        complete: true,
    };

    /* When */
    await inbox.poll();

    /* Then */
    assert.deepEqual(states(inbox), {'issue:movelab/connect#1': 'unread'});
    assert.deepEqual(inbox.summary().issue, {unread: 1, urgent: 0});
});

test('an issue assigned to someone else leaves, even from a capped answer', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.watched[LOCAL] = REPO;
    world.issues[REPO] = {viewer: ME, issues: [issueRead(1), issueRead(2)], complete: false};
    await inbox.poll();

    /* When */
    world.issues[REPO] = {
        viewer: ME,
        issues: [issueRead(1), issueRead(2, {assignees: ['colleague']})],
        complete: false,
    };
    await inbox.poll();

    /* Then */
    assert.deepEqual(Object.keys(states(inbox)), ['issue:movelab/connect#1']);
});

test('a comment by someone else wakes a backlogged issue', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.watched[LOCAL] = REPO;
    world.issues[REPO] = {viewer: ME, issues: [issueRead(1, {comments: 1})], complete: true};
    await inbox.poll();
    inbox.backlog('issue:movelab/connect#1');

    /* When */
    world.issues[REPO] = {viewer: ME, issues: [issueRead(1, {comments: 2, lastCommentBy: 'ben'})], complete: true};
    await inbox.poll();

    /* Then */
    assert.equal(inbox.item('issue:movelab/connect#1')!.state.kind, 'unread');
});

test("switching Watch issues off drops the repository's inbox items", async () => {
    /* Given */
    const {inbox, world} = setup();
    world.watched[LOCAL] = REPO;
    world.issues[REPO] = {viewer: ME, issues: [issueRead(1)], complete: true};
    await inbox.poll();

    /* When */
    delete world.watched[LOCAL];
    await inbox.poll();

    /* Then */
    assert.deepEqual(inbox.list('issue'), []);
});

test('a timed snooze wakes on the poll after its time', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}];
    await inbox.poll();
    inbox.snooze('bug:connect-api:a', world.now + HOUR);

    /* When */
    world.now += HOUR;
    await inbox.poll();

    /* Then */
    assert.equal(inbox.item('bug:connect-api:a')!.state.kind, 'unread');
});

test('done items are dropped seven days after they were done', async () => {
    /* Given */
    const {inbox, world} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}];
    await inbox.poll();
    inbox.startWork('bug:connect-api:a');
    inbox.finish('bug:connect-api:a');
    world.errors[PROJECT] = [];

    /* When */
    world.now += 7 * DAY;
    await inbox.poll();

    /* Then */
    assert.deepEqual(inbox.list(), []);
});

test('it polls at start and every five minutes after, until stopped', async () => {
    /* Given */
    const {inbox, timers, asked} = setup();

    /* When */
    inbox.start();
    await inbox.poll();
    const atStart = asked.length;
    timers.tick();
    await inbox.poll();

    /* Then */
    assert.equal(atStart, 3);
    assert.equal(asked.length, 6);
    inbox.stop();
    assert.equal(timers.pending, 0);
});

test('the inbox survives a restart from its store, notes and states included', async () => {
    /* Given */
    const {inbox, world, make} = setup();
    world.watched[LOCAL] = REPO;
    world.issues[REPO] = {viewer: ME, issues: [issueRead(1)], complete: true};
    await inbox.poll();
    inbox.setNotes('issue:movelab/connect#1', 'Ask Ben which export');
    inbox.markRead('issue:movelab/connect#1');

    /* When */
    const restarted = make();

    /* Then */
    const item = restarted.item('issue:movelab/connect#1')!;
    assert.equal(item.notes, 'Ask Ben which export');
    assert.equal(item.state.kind, 'read');
});

test('an action on a key the inbox does not hold answers null and writes nothing', () => {
    /* Given */
    const {inbox, store} = setup();

    /* When */
    const answer = inbox.markRead('bug:nope:nope');

    /* Then */
    assert.equal(answer, null);
    assert.equal(store.writes, 0);
});

test('a poll that changes nothing writes nothing and pushes nothing', async () => {
    /* Given */
    const {inbox, world, store, renderer} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}];
    await inbox.poll();
    const writes = store.writes;
    const pushes = renderer.only('inboxChanged').length;

    /* When */
    await inbox.poll();

    /* Then */
    assert.equal(store.writes, writes);
    assert.equal(renderer.only('inboxChanged').length, pushes);
});

// ── Which managers are set up (#416) ──

test('the Bug manager is set up with a token and an opted-in project, the Issue manager with a watched project', () => {
    /* Given */
    const {inbox} = setup({watched: {[LOCAL]: REPO}});

    /* When */
    const configured = inbox.summary().configured;

    /* Then */
    assert.deepEqual(configured, {bug: true, issue: true});
});

test('without a token, or with every project opted out, the Bug manager is not set up', () => {
    /* Given */
    const tokenless = setup({token: false});
    const optedOut = setup({
        bugsnag: {
            projects: [{id: PROJECT, name: 'Connect API', optedIn: false, localProject: LOCAL}],
            trending: THRESHOLDS,
        },
    });

    /* When */
    const configured = [tokenless.inbox.summary().configured.bug, optedOut.inbox.summary().configured.bug];

    /* Then */
    assert.deepEqual(configured, [false, false]);
});

test('a project put on Watch issues brings the Issue manager at once, and its repository is read without waiting', async () => {
    /* Given */
    const {inbox, world, renderer} = setup();
    inbox.start();
    await inbox.poll();
    world.watched[LOCAL] = REPO;
    world.issues[REPO] = {viewer: ME, issues: [issueRead(1)], complete: true};

    /* When */
    inbox.settingsChanged();
    const atOnce = (renderer.only('inboxChanged').at(-1)![1] as InboxSummary).configured;
    // The poll the change started.
    await inbox.poll();

    /* Then */
    assert.deepEqual(atOnce, {bug: true, issue: true});
    assert.deepEqual(states(inbox), {'issue:movelab/connect#1': 'unread'});
});

test('a settings change that changes nothing watched pushes nothing', async () => {
    /* Given */
    const {inbox, world, renderer} = setup();
    world.errors[PROJECT] = [{error: bugsnagError('a')}];
    inbox.start();
    await inbox.poll();
    const pushes = renderer.only('inboxChanged').length;

    /* When */
    inbox.settingsChanged();

    /* Then */
    assert.equal(renderer.only('inboxChanged').length, pushes);
});
