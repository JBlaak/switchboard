/**
 * The pull request peek: its slice (open, answer, a stale answer, close,
 * Show diff, the layout) and the one door every link goes through, which
 * sends a PR link to the peek and anything else to the browser. The actions
 * run against a fake `window.api`.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialPrPeekState, prPeekReducer} from '../src/renderer/state/pr-peek-slice';
import type {PrPeekState} from '../src/renderer/state/pr-peek-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import type {FileDiff, PullRequestStatus} from '../src/domain/session-work/model';
import type {PullRequestPeek, PullRequestRef} from '../src/domain/session-work/pull-request-link';
import {dispatch, getState} from '../src/renderer/state/app-store';
import {
    closePullRequestPeek,
    expandPeekFile,
    openLink,
    openPeekOnGitHub,
    openPullRequestPeek,
    routeLink,
    togglePeekDiffMode,
} from '../src/renderer/ui/pr-view/actions';

const REF: PullRequestRef = {repository: 'acme/app', number: 12};
const URL = 'https://github.com/acme/app/pull/12/checks';

function run(state: PrPeekState, ...events: RendererEvent[]): PrPeekState {
    return events.reduce(prPeekReducer, state);
}

function file(path: string, patch: Partial<FileDiff> = {}): FileDiff {
    return {path, status: 'modified', additions: 1, deletions: 0, hunks: [], binary: false, ...patch};
}

function pr(patch: Partial<PullRequestStatus> = {}): PullRequestStatus {
    return {number: 12, url: URL, repository: 'acme/app', title: 'Fix it', state: 'open', closes: [], ...patch};
}

function answer(ref: PullRequestRef = REF, patch: Partial<PullRequestPeek> = {}): PullRequestPeek {
    return {ref, url: URL, pr: pr(), files: [file('src/a.ts')], ...patch};
}

const opened = (id: number, ref: PullRequestRef = REF, url = URL): RendererEvent => ({
    type: 'prPeekOpened',
    id,
    ref,
    url,
});

// ── The slice ──

test('a followed PR link opens the peek, loading, with the link as it was', () => {
    /* Given */
    const closed = initialPrPeekState;

    /* When */
    const state = run(closed, opened(1));

    /* Then */
    assert.equal(state.peek?.phase, 'loading');
    assert.deepEqual(state.peek?.ref, REF);
    assert.equal(state.peek?.url, URL);
    assert.equal(state.peek?.pr, null);
    assert.deepEqual(state.peek?.files, []);
});

test("gh's answer fills the peek in: the PR, its files, no error", () => {
    /* Given */
    const loading = run(initialPrPeekState, opened(1));

    /* When */
    const state = run(loading, {type: 'prPeekAnswered', id: 1, peek: answer()});

    /* Then */
    assert.equal(state.peek?.phase, 'loaded');
    assert.equal(state.peek?.pr?.title, 'Fix it');
    assert.deepEqual(
        state.peek?.files.map((f) => f.path),
        ['src/a.ts'],
    );
    assert.equal(state.peek?.error, null);
});

test('an answer that says why there is no diff shows that reason', () => {
    /* Given */
    const loading = run(initialPrPeekState, opened(1));

    /* When */
    const state = run(loading, {
        type: 'prPeekAnswered',
        id: 1,
        peek: answer(REF, {pr: null, files: [], error: 'gh is not signed in'}),
    });

    /* Then */
    assert.equal(state.peek?.phase, 'loaded');
    assert.equal(state.peek?.error, 'gh is not signed in');
});

test('an ask that failed outright ends the loading with its error', () => {
    /* Given */
    const loading = run(initialPrPeekState, opened(1));

    /* When */
    const state = run(loading, {type: 'prPeekFailed', id: 1, error: 'boom'});

    /* Then */
    assert.equal(state.peek?.phase, 'loaded');
    assert.equal(state.peek?.error, 'boom');
});

test("a slow PR's answer never paints over the PR opened after it", () => {
    /* Given */
    const other: PullRequestRef = {repository: 'acme/app', number: 13};
    const second = run(initialPrPeekState, opened(1), opened(2, other, 'https://github.com/acme/app/pull/13'));

    /* When */
    const state = run(second, {type: 'prPeekAnswered', id: 1, peek: answer()});

    /* Then */
    assert.equal(state, second);
    assert.equal(state.peek?.ref.number, 13);
    assert.equal(state.peek?.phase, 'loading');
});

test('an answer for a peek already closed is dropped', () => {
    /* Given */
    const closed = run(initialPrPeekState, opened(1), {type: 'prPeekClosed'});

    /* When */
    const state = run(
        closed,
        {type: 'prPeekAnswered', id: 1, peek: answer()},
        {
            type: 'prPeekFailed',
            id: 1,
            error: 'late',
        },
    );

    /* Then */
    assert.equal(state.peek, null);
});

test('closing takes the peek away and keeps the layout', () => {
    /* Given */
    const open = run(initialPrPeekState, {type: 'prPeekModeSet', mode: 'split'}, opened(1));

    /* When */
    const state = run(open, {type: 'prPeekClosed'});

    /* Then */
    assert.equal(state.peek, null);
    assert.equal(state.mode, 'split');
});

test('Show diff opens a collapsed file once, and only on the peek it was clicked in', () => {
    /* Given */
    const loaded = run(initialPrPeekState, opened(1), {type: 'prPeekAnswered', id: 1, peek: answer()});

    /* When */
    const expanded = run(loaded, {type: 'prPeekFileExpanded', id: 1, path: 'package-lock.json'});
    const again = run(expanded, {type: 'prPeekFileExpanded', id: 1, path: 'package-lock.json'});
    const stale = run(expanded, {type: 'prPeekFileExpanded', id: 7, path: 'other.lock'});

    /* Then */
    assert.deepEqual(expanded.peek?.expanded, ['package-lock.json']);
    assert.equal(again, expanded);
    assert.equal(stale, expanded);
});

test('a new peek starts with every collapsed file collapsed again', () => {
    /* Given */
    const expanded = run(initialPrPeekState, opened(1), {type: 'prPeekFileExpanded', id: 1, path: 'yarn.lock'});

    /* When */
    const state = run(expanded, opened(2));

    /* Then */
    assert.deepEqual(state.peek?.expanded, []);
});

// ── The door every link goes through ──

test('a PR link, any page of it, routes to the peek', () => {
    /* Given */
    const links = [
        'https://github.com/acme/app/pull/12',
        'https://github.com/acme/app/pull/12/files',
        'https://github.com/acme/app/pull/12#discussion_r1',
    ];

    /* When */
    const routes = links.map(routeLink);

    /* Then */
    for (const route of routes) assert.deepEqual(route, {kind: 'peek', ref: REF});
});

test('an issue, a run, a Notion page or a mail link goes to the browser', () => {
    /* Given */
    const links = [
        'https://github.com/acme/app/issues/12',
        'https://github.com/acme/app/actions/runs/99',
        'https://www.notion.so/abc',
        'mailto:someone@example.com',
    ];

    /* When */
    const routes = links.map(routeLink);

    /* Then */
    for (const route of routes) assert.deepEqual(route, {kind: 'external'});
});

/** A main that answers `peekPullRequest` with `peek`, recording every call. */
function installMain(peek: (ref: PullRequestRef) => Promise<PullRequestPeek>): [string, unknown][] {
    const calls: [string, unknown][] = [];
    const api = {
        openExternal: async (url: string) => {
            calls.push(['openExternal', url]);
        },
        peekPullRequest: (ref: PullRequestRef) => {
            calls.push(['peekPullRequest', ref]);
            return peek(ref);
        },
    };
    Object.assign(globalThis, {window: {api}});
    return calls;
}

test('following a non-PR link opens it in the browser and leaves the peek alone', () => {
    /* Given */
    dispatch({type: 'prPeekClosed'});
    const calls = installMain(async () => answer());

    /* When */
    openLink('https://github.com/acme/app/issues/3');

    /* Then */
    assert.deepEqual(calls, [['openExternal', 'https://github.com/acme/app/issues/3']]);
    assert.equal(getState().prPeek.peek, null);
});

test('following a PR link opens the peek and fills it with what main answers', async () => {
    /* Given */
    dispatch({type: 'prPeekClosed'});
    const calls = installMain(async () => answer());

    /* When */
    openLink(URL);
    const loading = getState().prPeek.peek;
    await new Promise((resolve) => setImmediate(resolve));

    /* Then */
    assert.equal(loading?.phase, 'loading');
    assert.deepEqual(calls, [['peekPullRequest', REF]]);
    assert.equal(getState().prPeek.peek?.phase, 'loaded');
    assert.equal(getState().prPeek.peek?.pr?.title, 'Fix it');
    closePullRequestPeek();
});

test('a peek closed before main answered stays closed', async () => {
    /* Given */
    let release!: (peek: PullRequestPeek) => void;
    installMain(() => new Promise((resolve) => (release = resolve)));
    const pending = openPullRequestPeek(REF, URL);

    /* When */
    closePullRequestPeek();
    release(answer());
    await pending;

    /* Then */
    assert.equal(getState().prPeek.peek, null);
});

test('Open on GitHub opens the link as it was followed, /checks and all', async () => {
    /* Given */
    const calls = installMain(async () => answer());
    await openPullRequestPeek(REF, URL);

    /* When */
    openPeekOnGitHub();

    /* Then */
    assert.deepEqual(calls.at(-1), ['openExternal', URL]);
    assert.notEqual(getState().prPeek.peek, null);
    closePullRequestPeek();
});

test('Show diff and u act on the open peek', async () => {
    /* Given */
    installMain(async () => answer());
    await openPullRequestPeek(REF, URL);
    const mode = getState().prPeek.mode;

    /* When */
    expandPeekFile('package-lock.json');
    togglePeekDiffMode();

    /* Then */
    assert.deepEqual(getState().prPeek.peek?.expanded, ['package-lock.json']);
    assert.notEqual(getState().prPeek.mode, mode);
    closePullRequestPeek();
});
