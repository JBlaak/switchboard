/**
 * The full view of a pull request (pr-view): the session page that opens
 * with the PR selected, and the page of its own for a PR no session opened.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {highlightedSession} from '../src/renderer/state/main-area-slice';
import {workTabOf, workTabsFor} from '../src/renderer/state/session-work-slice';
import {workPageTitle} from '../src/renderer/ui/session-work/describe';
import {pullRequestOwners} from '../src/renderer/ui/pr-view/owners';
import {pullRequestPageId} from '../src/domain/session-work/pull-request-link';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {SessionWorkItem, SessionWorkSnapshot} from '../src/domain/session-work/model';
import type {SessionRow} from '../src/domain/session/session';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const AT = Date.parse('2026-11-10T10:00:00.000Z');
const REF = {repository: 'acme/api', number: 52};
const PULL_ID = pullRequestPageId(REF);

function pr(number: number, state: 'open' | 'merged' = 'open', url?: string): SessionWorkItem {
    const prUrl = url ?? `https://github.com/acme/api/pull/${number}`;
    return {
        id: 'pr:' + prUrl,
        kind: 'pr',
        pr: {number, url: prUrl, repository: 'acme/api', title: `PR ${number}`, state, closes: []},
        location: null,
        diff: {kind: 'pull-request', repository: 'acme/api', number},
        activity: null,
    };
}

function snapshot(items: SessionWorkItem[], sessionId = 's1'): SessionWorkSnapshot {
    return {
        sessionId,
        repository: 'acme/api',
        items,
        footprint: {worktrees: 1, branches: 1},
        queued: 0,
        gh: 'ok',
        updatedAt: new Date(AT).toISOString(),
    };
}

function opened(sessionId = 's1', pullRequest = REF): RendererEvent {
    return {type: 'sessionWorkOpened', sessionId, name: 'Fix login', at: AT, pullRequest};
}

function row(sessionId: string, modified: string, urls: string[]): SessionRow {
    return {
        sessionId,
        summary: '',
        firstPrompt: '',
        projectPath: '/dev/api',
        created: modified,
        modified,
        messageCount: 1,
        pullRequests: urls.map((url) => ({url, number: Number(url.split('/').pop()), repository: ''})),
        name: null,
        starred: 0,
        archived: 0,
    };
}

// ── The PR a session opened: its page, with that PR selected ──

test('pr full view: the first snapshot selects the linked PR, not the first item in progress', () => {
    /* Given */
    const open = run(initialRendererState('s1'), opened());

    /* When */
    const filled = run(open, {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(51), pr(52)])});

    /* Then */
    assert.equal(filled.sessionWork.page?.selectedItemId, 'pr:https://github.com/acme/api/pull/52');
    assert.equal(filled.sessionWork.page?.wantedPullRequest, null);
});

test('pr full view: the PR is found by its URL even when the link was spelled differently', () => {
    /* Given */
    const open = run(initialRendererState('s1'), opened('s1', {repository: 'ACME/Api', number: 52}));
    const item = pr(52, 'open', 'https://github.com/acme/api/pull/52/files');

    /* When */
    const filled = run(open, {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(51), item])});

    /* Then */
    assert.equal(filled.sessionWork.page?.selectedItemId, item.id);
});

test('pr full view: a merged PR is selected with the Done group opened, so it shows in the list', () => {
    /* Given */
    const open = run(initialRendererState('s1'), opened());

    /* When */
    const filled = run(open, {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(51), pr(52, 'merged')])});

    /* Then */
    assert.equal(filled.sessionWork.page?.selectedItemId, 'pr:https://github.com/acme/api/pull/52');
    assert.equal(filled.sessionWork.page?.doneExpanded, true);
});

test('pr full view: a PR the snapshot lacks yet is waited for, and selected when it arrives', () => {
    /* Given */
    const open = run(initialRendererState('s1'), opened());
    const first = run(open, {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(51)])});

    /* When */
    const second = run(first, {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(51), pr(52)])});

    /* Then */
    assert.equal(first.sessionWork.page?.selectedItemId, 'pr:https://github.com/acme/api/pull/51');
    assert.equal(second.sessionWork.page?.selectedItemId, 'pr:https://github.com/acme/api/pull/52');
});

test('pr full view: a selection of the user’s own drops the wait for the linked PR', () => {
    /* Given */
    const open = run(initialRendererState('s1'), opened());
    const first = run(
        open,
        {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(50), pr(51)])},
        {type: 'sessionWorkItemSelected', itemId: 'pr:https://github.com/acme/api/pull/51'},
    );

    /* When */
    const second = run(first, {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(50), pr(51), pr(52)])});

    /* Then */
    assert.equal(second.sessionWork.page?.selectedItemId, 'pr:https://github.com/acme/api/pull/51');
});

test('pr full view: a link to a PR of the page already open selects it there', () => {
    /* Given */
    const filled = run(
        initialRendererState('s1'),
        {type: 'sessionWorkOpened', sessionId: 's1', name: 'Fix login', at: AT},
        {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(51), pr(52)])},
    );

    /* When */
    const next = run(filled, opened());

    /* Then */
    assert.equal(filled.sessionWork.page?.selectedItemId, 'pr:https://github.com/acme/api/pull/51');
    assert.equal(next.sessionWork.page?.selectedItemId, 'pr:https://github.com/acme/api/pull/52');
});

// ── Who owns the PR ──

test('pr full view: the owner is the session whose PRs include it, by URL whatever its case or page', () => {
    /* Given */
    const rows = [
        row('a', '2026-11-09T10:00:00Z', ['https://github.com/acme/web/pull/52']),
        row('b', '2026-11-09T11:00:00Z', ['https://github.com/Acme/API/pull/52/checks']),
    ];

    /* When */
    const owners = pullRequestOwners(rows, REF);

    /* Then */
    assert.deepEqual(owners, ['b']);
});

test('pr full view: of several owners the most recently active comes first', () => {
    /* Given */
    const url = 'https://github.com/acme/api/pull/52';
    const rows = [
        row('old', '2026-11-01T10:00:00Z', [url]),
        row('new', '2026-11-09T10:00:00Z', [url]),
        row('mid', '2026-11-05T10:00:00Z', [url]),
    ];

    /* When */
    const owners = pullRequestOwners(rows, REF);

    /* Then */
    assert.deepEqual(owners, ['new', 'mid', 'old']);
});

test('pr full view: a PR no session opened has no owner, so it gets a page of its own', () => {
    /* Given */
    const rows = [row('a', '2026-11-09T10:00:00Z', ['https://github.com/acme/api/pull/53'])];

    /* When */
    const owners = pullRequestOwners(rows, REF);

    /* Then */
    assert.deepEqual(owners, []);
});

test('pr full view: a session PR without a GitHub URL matches by its repository and number', () => {
    /* Given */
    const session = row('a', '2026-11-09T10:00:00Z', []);
    const rows = [
        {...session, pullRequests: [{url: 'https://ghe.example/acme/api/pull/52', number: 52, repository: 'acme/api'}]},
    ];

    /* When */
    const owners = pullRequestOwners(rows, REF);

    /* Then */
    assert.deepEqual(owners, ['a']);
});

// ── The page of its own ──

test('pr full view: a PR’s own page is routed like a work page but lights no session', () => {
    /* Given */
    const state = run(
        initialRendererState('s1'),
        {type: 'activeSessionChanged', sessionId: 's1'},
        {type: 'sessionShown', sessionId: 's1', name: 's1'},
    );

    /* When */
    const open = run(state, opened(PULL_ID));

    /* Then */
    assert.deepEqual(open.mainArea.route, {kind: 'sessionWork', sessionId: PULL_ID});
    assert.equal(highlightedSession(open.mainArea), null);
    assert.equal(open.sessionWork.page?.sessionId, PULL_ID);
});

test('pr full view: a PR’s own page opens over a project page', () => {
    /* Given */
    const project = run(initialRendererState('s1'), {
        type: 'projectOpened',
        projectPath: '/dev/api',
        view: {kind: 'overview'},
    });

    /* When */
    const open = run(project, opened(PULL_ID));

    /* Then */
    assert.deepEqual(open.mainArea.route, {kind: 'sessionWork', sessionId: PULL_ID});
    assert.equal(open.sessionWork.page?.sessionId, PULL_ID);
});

test('pr full view: the session to return to going away leaves a PR’s own page open', () => {
    /* Given */
    const open = run(initialRendererState('s1'), opened(PULL_ID));

    /* When */
    const next = run(open, {type: 'activeSessionChanged', sessionId: null});

    /* Then */
    assert.deepEqual(next.mainArea.route, {kind: 'sessionWork', sessionId: PULL_ID});
    assert.equal(next.sessionWork.page?.sessionId, PULL_ID);
});

test('pr full view: Esc on a PR’s own page goes back to the session to return to', () => {
    /* Given */
    const open = run(initialRendererState('s1'), {type: 'activeSessionChanged', sessionId: 's1'}, opened(PULL_ID));

    /* When */
    const closed = run(open, {type: 'sessionWorkClosed', sessionId: PULL_ID});

    /* Then */
    assert.deepEqual(closed.mainArea.route, {kind: 'session', sessionId: 's1'});
    assert.equal(closed.sessionWork.page, null);
});

test('pr full view: a session put on screen takes the main area from a PR’s own page', () => {
    /* Given */
    const open = run(initialRendererState(), opened(PULL_ID));

    /* When */
    const next = run(
        open,
        {type: 'activeSessionChanged', sessionId: 's2'},
        {type: 'sessionShown', sessionId: 's2', name: 's2'},
    );

    /* Then */
    assert.deepEqual(next.mainArea.route, {kind: 'session', sessionId: 's2'});
    assert.equal(next.sessionWork.page, null);
});

test('pr full view: a PR’s own page has the Work tab alone, whatever was asked for', () => {
    /* Given */
    const open = run(initialRendererState(), opened(PULL_ID));

    /* When */
    const next = run(open, {type: 'sessionWorkTabSet', sessionId: PULL_ID, tab: 'plan'});

    /* Then */
    assert.equal(workTabOf(next.sessionWork, PULL_ID, true), 'work');
    assert.deepEqual(workTabsFor(true, true), ['work']);
    assert.deepEqual(workTabsFor(false), ['work', 'plan']);
});

test('pr full view: a PR’s own page is titled by the PR, with its title once a snapshot has it', () => {
    /* Given */
    const open = run(initialRendererState(), opened(PULL_ID));

    /* When */
    const filled = run(open, {type: 'sessionWorkSnapshot', snapshot: snapshot([pr(52)], PULL_ID)});

    /* Then */
    assert.equal(workPageTitle(open.sessionWork.page!), 'acme/api #52');
    assert.equal(workPageTitle(filled.sessionWork.page!), 'acme/api #52 · PR 52');
    assert.equal(filled.sessionWork.page?.selectedItemId, 'pr:https://github.com/acme/api/pull/52');
});

test('pr full view: a session’s page keeps its `Work · name` title', () => {
    /* Given */
    const open = run(initialRendererState('s1'), opened());

    /* When */
    const title = workPageTitle(open.sessionWork.page!);

    /* Then */
    assert.equal(title, 'Work · Fix login');
});
