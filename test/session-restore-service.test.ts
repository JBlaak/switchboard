import {test} from 'node:test';
import assert from 'node:assert/strict';

import {ActiveSession} from '../src/application/model/active-session';
import {SessionRegistry} from '../src/application/model/session-registry';
import {LIVE_SESSIONS_KEY, SessionRestoreService} from '../src/application/services/session-restore-service';
import {SessionLauncher} from '../src/application/services/session-launcher';
import {SessionLifecycle} from '../src/application/services/session-lifecycle';
import {encodeProjectPath} from '../src/domain/project/project-path';
import {fakePty, fakeRenderer, fakeTerminals, fakeTimers, silentLog} from './support/fakes';
import type {LiveSessionEntry} from '../src/domain/session/restore';
import type {OpenSessionRequest, SessionLauncherDeps} from '../src/application/services/session-launcher';

/**
 * Keeping the record of live local sessions, and resuming what is in it when
 * Switchboard starts again.
 */

const NOW = Date.parse('2026-11-06T10:00:00.000Z');

const openToolTail = (name: string) =>
    [
        JSON.stringify({type: 'user', message: {content: 'go'}}),
        JSON.stringify({type: 'assistant', message: {content: [{type: 'tool_use', id: 't1', name}]}}),
    ].join('\n');
const restingTail = JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'Done.'}]}});

function harness({
    stored = [],
    folders = ['/repo'],
    tails = {},
    enabled = true,
    failOpen = [],
}: {
    stored?: LiveSessionEntry[];
    folders?: string[];
    tails?: Record<string, string>;
    enabled?: boolean;
    failOpen?: string[];
} = {}) {
    const values = new Map<string, unknown>([[LIVE_SESSIONS_KEY, stored]]);
    const registry = new SessionRegistry();
    const renderer = fakeRenderer();
    const opened: OpenSessionRequest[] = [];

    const addSession = (sessionId: string, projectPath = '/repo'): ActiveSession => {
        const session = new ActiveSession({
            pty: fakePty(),
            projectPath,
            projectFolder: encodeProjectPath(projectPath),
            knownTranscriptIds: new Set(),
            sessionSlug: null,
            isPlainTerminal: false,
            remote: null,
            openedAt: NOW,
        });
        registry.add(sessionId, session);
        return session;
    };

    const restore = new SessionRestoreService({
        store: {
            get: <T>(key: string) => (values.get(key) ?? null) as T | null,
            set: (key, value) => values.set(key, value),
        },
        enabled: () => enabled,
        optionsFor: () => ({permissionMode: 'plan'}),
        launcher: {
            async open(request) {
                opened.push(request);
                if (failOpen.includes(request.sessionId)) return {ok: false, error: 'No conversation found'};
                addSession(request.sessionId, request.projectPath);
                restore.started(request.sessionId, request.projectPath);
                return {ok: true, reattached: false};
            },
        },
        registry,
        transcripts: {
            readTail: (_folder, sessionId) => tails[sessionId] ?? '',
            sessionMtimeMs: (_folder, sessionId) => (sessionId in tails ? NOW : null),
        },
        renderer,
        fileExists: (path) => folders.includes(path),
        clock: {now: () => NOW},
        log: silentLog,
    });

    const record = () => values.get(LIVE_SESSIONS_KEY) as LiveSessionEntry[];
    const ids = () => record().map((e) => e.sessionId);
    return {restore, registry, renderer, opened, record, ids, addSession};
}

const entry = (sessionId: string, projectPath = '/repo', startedAt = '2026-11-06T09:00:00.000Z') => ({
    sessionId,
    projectPath,
    startedAt,
});

// --- Keeping the record ---

test('a session that starts is recorded with its folder and start', () => {
    /* Given */
    const h = harness();

    /* When */
    h.restore.started('a', '/repo/worktree');

    /* Then */
    assert.deepEqual(h.record(), [entry('a', '/repo/worktree', '2026-11-06T10:00:00.000Z')]);
});

test('a session the user ends leaves the record', () => {
    /* Given */
    const h = harness({stored: [entry('a'), entry('b')]});
    const session = h.addSession('a');

    /* When */
    h.restore.ended('a', session);

    /* Then */
    assert.deepEqual(h.ids(), ['b']);
});

test('a session the app ended on its way out stays in the record', () => {
    /* Given */
    const h = harness({stored: [entry('a')]});
    const session = h.addSession('a');
    session.endedByApp = true;

    /* When */
    h.restore.ended('a', session);

    /* Then */
    assert.deepEqual(h.ids(), ['a']);
});

test('once the app is quitting, every session that ends stays in the record', () => {
    /* Given */
    const h = harness({stored: [entry('a')]});
    const session = h.addSession('a');
    h.restore.freeze();

    /* When */
    h.restore.ended('a', session);

    /* Then */
    assert.deepEqual(h.ids(), ['a']);
});

test('a re-keyed session is recorded under its new id', () => {
    /* Given */
    const h = harness({stored: [entry('old')]});

    /* When */
    h.restore.rekeyed('old', 'new');

    /* Then */
    assert.deepEqual(h.ids(), ['new']);
});

test('quitting marks the running sessions as ended by the app', () => {
    /* Given */
    const registry = new SessionRegistry();
    const lifecycle = new SessionLifecycle({
        registry,
        terminals: fakeTerminals(),
        renderer: fakeRenderer(),
        remote: {observeOutput() {}, handleExit: () => false, markDisconnected() {}},
        timers: fakeTimers(),
        log: silentLog,
    });
    const session = new ActiveSession({
        pty: fakePty(),
        projectPath: '/repo',
        projectFolder: '-repo',
        knownTranscriptIds: new Set(),
        sessionSlug: null,
        isPlainTerminal: false,
        remote: null,
        openedAt: 0,
    });
    registry.add('a', session);

    /* When */
    lifecycle.terminateAll();

    /* Then */
    assert.equal(session.endedByApp, true);
});

// --- Restoring ---

test('a recorded session is resumed in its folder, with the project’s options and no prompt', async () => {
    /* Given */
    const h = harness({stored: [entry('a', '/repo')], tails: {a: restingTail}});

    /* When */
    await h.restore.restore();

    /* Then */
    assert.deepEqual(h.opened, [
        {sessionId: 'a', projectPath: '/repo', isNew: false, options: {permissionMode: 'plan'}},
    ]);
    assert.equal(h.registry.has('a'), true);
    assert.deepEqual(h.ids(), ['a']);
});

test('sessions are resumed first started first', async () => {
    /* Given */
    const h = harness({
        stored: [entry('b', '/repo', '2026-11-06T09:30:00.000Z'), entry('a', '/repo', '2026-11-06T09:00:00.000Z')],
        tails: {a: restingTail, b: restingTail},
    });

    /* When */
    await h.restore.restore();

    /* Then */
    assert.deepEqual(
        h.opened.map((r) => r.sessionId),
        ['a', 'b'],
    );
});

test('a session already running is not resumed again', async () => {
    /* Given */
    const h = harness({stored: [entry('a')], tails: {a: restingTail}});
    h.addSession('a');

    /* When */
    await h.restore.restore();

    /* Then */
    assert.deepEqual(h.opened, []);
});

test('a session whose folder is gone is skipped, dropped and reported', async () => {
    /* Given */
    const h = harness({stored: [entry('a', '/gone/worktree')], folders: [], tails: {a: restingTail}});
    await h.restore.restore();

    /* When */
    h.restore.rendererReady();

    /* Then */
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.ids(), []);
    assert.deepEqual(h.renderer.only('statusUpdate'), [
        ['statusUpdate', 'Couldn’t bring a session back: its folder is gone (/gone/worktree)', 'done'],
    ]);
});

test('a session with no transcript is dropped without a resume', async () => {
    /* Given */
    const h = harness({stored: [entry('a')]});

    /* When */
    await h.restore.restore();

    /* Then */
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.ids(), []);
});

test('a session that cannot be resumed is dropped', async () => {
    /* Given */
    const h = harness({stored: [entry('a')], tails: {a: restingTail}, failOpen: ['a']});

    /* When */
    await h.restore.restore();

    /* Then */
    assert.deepEqual(h.ids(), []);
});

test('a session cut off mid tool call is marked interrupted once the window is ready, and sent nothing', async () => {
    /* Given */
    const h = harness({stored: [entry('a')], tails: {a: openToolTail('Bash')}});
    await h.restore.restore();

    /* When */
    h.restore.rendererReady();

    /* Then */
    assert.deepEqual(h.renderer.only('sessionNeedsAttention'), [['sessionNeedsAttention', 'a']]);
    assert.deepEqual(h.renderer.only('terminalNotification'), [
        ['terminalNotification', 'a', 'Interrupted by restart: Bash'],
    ]);
    const session = h.registry.get('a')!;
    assert.match(session.output.chunks().join(''), /Interrupted by restart: Bash/);
    assert.deepEqual((session.pty as ReturnType<typeof fakePty>).writes, []);
});

test('a session whose turn was at rest is not marked', async () => {
    /* Given */
    const h = harness({stored: [entry('a')], tails: {a: restingTail}});
    await h.restore.restore();

    /* When */
    h.restore.rendererReady();

    /* Then */
    assert.deepEqual(h.renderer.events, []);
});

test('a window that was ready before the restore finished still hears it', async () => {
    /* Given */
    const h = harness({stored: [entry('a')], tails: {a: openToolTail('Edit')}});
    const restoring = h.restore.restore();
    h.restore.rendererReady();

    /* When */
    await restoring;

    /* Then */
    assert.deepEqual(h.renderer.only('terminalNotification'), [
        ['terminalNotification', 'a', 'Interrupted by restart: Edit'],
    ]);
});

test('with the setting off nothing is resumed and the record is cleared', async () => {
    /* Given */
    const h = harness({stored: [entry('a')], tails: {a: restingTail}, enabled: false});

    /* When */
    await h.restore.restore();

    /* Then */
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.ids(), []);
});

// --- What feeds the record ---

function launcherHarness() {
    const started: [string, string][] = [];
    const launcher = new SessionLauncher({
        registry: new SessionRegistry(),
        terminals: fakeTerminals(),
        shells: {list: () => [], resolve: () => ({id: 'zsh', name: 'zsh', path: '/bin/zsh'})},
        transcripts: {listSessionIds: () => [], readSlug: () => null},
        settings: {shellProfileId: () => null},
        lifecycle: {wire() {}},
        remote: {},
        renderer: fakeRenderer(),
        questions: {settingsFor: () => null},
        git: {worktreeRoot: async () => null},
        clock: {now: () => NOW},
        timers: fakeTimers(),
        log: silentLog,
        fileExists: () => true,
        liveSessions: {started: (sessionId: string, projectPath: string) => started.push([sessionId, projectPath])},
    } as unknown as SessionLauncherDeps);
    return {launcher, started};
}

test('a local Claude session the launcher starts is recorded', async () => {
    /* Given */
    const h = launcherHarness();

    /* When */
    await h.launcher.open({sessionId: 'a', projectPath: '/repo', isNew: false});

    /* Then */
    assert.deepEqual(h.started, [['a', '/repo']]);
});

test('a plain terminal is not recorded', async () => {
    /* Given */
    const h = launcherHarness();

    /* When */
    await h.launcher.open({sessionId: 't', projectPath: '/repo', isNew: true, options: {type: 'terminal'}});

    /* Then */
    assert.deepEqual(h.started, []);
});
