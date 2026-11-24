import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import './support/static-markup-dom';
import {TerminalHeaderInfoContent} from '../src/renderer/ui/terminal/TerminalHeader';
import {SessionTrayContent} from '../src/renderer/ui/session-tray/SessionTrayContent';
import type {SessionTrayActions, SessionTrayContentProps} from '../src/renderer/ui/session-tray/SessionTrayContent';
import {
    contextPercent,
    linkMeta,
    prFreshness,
    promptFacts,
    pullRequestForKey,
    pullRequestKeys,
    runningTimeLabel,
    seededPullRequests,
    sessionMetaLine,
    trayLinks,
} from '../src/renderer/ui/session-tray/tray-view';
import {LINKS_GITHUB_TTL_MS, type LinkedPr, type SessionLink} from '../src/domain/session/links';
import type {SessionStats} from '../src/domain/session/stats';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');

const pr = (number: number, status: Extract<SessionLink, {kind: 'pr'}>['status']): SessionLink => ({
    kind: 'pr',
    key: 'pr:https://github.com/acme/app/pull/' + number,
    title: 'PR ' + number,
    url: 'https://github.com/acme/app/pull/' + number,
    repository: 'acme/app',
    number,
    status,
});

const page = (id: string, shownAt: number): SessionLink => ({
    kind: 'page',
    key: 'page:' + id,
    title: 'Page ' + id,
    id,
    shownAt,
    status: null,
});

const task: SessionLink = {
    kind: 'task',
    key: 'task:t1',
    title: 'Ship the tray',
    id: 't1',
    url: null,
    status: 'In progress',
};

const stats: SessionStats = {
    contextUsed: 0.62,
    messageCount: 125,
    startedAt: '2026-11-06T10:48:00.000Z',
    branch: 'feat/session-tray',
    shell: 'zsh',
};

// ── The slimmed bar ──

test('the bar shows name, project and branch, with the process title only as the name’s tooltip', () => {
    /* When */
    const html = renderToStaticMarkup(
        createElement(TerminalHeaderInfoContent, {
            name: 'Session bar hover utilities',
            title: '✳ Claude Code',
            project: createElement('span', {id: 'terminal-header-project'}, 'JBlaak/switchboard'),
            branch: 'feat/session-tray',
            trayOpen: false,
        }),
    );

    /* Then */
    assert.match(html, /<span id="terminal-header-name" title="✳ Claude Code">Session bar hover utilities<\/span>/);
    assert.match(html, /id="terminal-header-project"[^>]*>JBlaak\/switchboard</);
    assert.match(html, /id="terminal-header-branch"[^>]*>feat\/session-tray</);
    assert.match(html, /aria-label="Session tools"[^>]*aria-expanded="false"/);
    assert.doesNotMatch(
        html,
        /terminal-header-pty-title|terminal-header-id|terminal-header-shell|terminal-header-task/,
    );
});

test('the bar leaves the branch out when there is none, and says the tray is open while it is', () => {
    /* When */
    const html = renderToStaticMarkup(
        createElement(TerminalHeaderInfoContent, {
            name: 'Detached',
            title: '',
            project: null,
            branch: null,
            trayOpen: true,
        }),
    );

    /* Then */
    assert.doesNotMatch(html, /terminal-header-branch|terminal-header-project/);
    assert.doesNotMatch(html, /title=""/);
    assert.match(html, /aria-expanded="true"/);
});

// ── The tray's markup ──

const noActions = new Proxy({}, {get: () => () => undefined}) as SessionTrayActions;

function tray(overrides: Partial<SessionTrayContentProps> = {}): string {
    return renderToStaticMarkup(
        createElement(SessionTrayContent, {
            sessionId: 's1',
            open: true,
            sent: null,
            prompts: [
                {id: 'a', label: 'Where are we?', text: 'Where are we?', mode: 'send', scope: 'global', key: 1},
                {id: 'b', label: 'Commit + PR', text: 'Commit {branch}', mode: 'input', scope: 'project', key: 2},
            ],
            links: trayLinks([pr(331, {state: 'open', checks: 'passing', dot: 'green', mine: true}), task], null),
            stats,
            editor: {available: true, directory: '/w', editor: 'phpstorm', app: 'PhpStorm'},
            handOffHosts: null,
            bringBack: false,
            running: true,
            copied: false,
            now: NOW,
            actions: noActions,
            ...overrides,
        }),
    );
}

test('the tray has the four groups, the prompts with their ⌘ keys, and real buttons and links', () => {
    /* When */
    const html = tray();

    /* Then */
    assert.match(html, /<section id="session-tray" class="session-tray is-open" aria-label="Session tools">/);
    for (const group of ['Ask', 'Links', 'Workspace', 'Session']) assert.match(html, new RegExp(`>${group}<`));
    assert.match(
        html,
        /aria-label="Send: Where are we\?"[^>]*><span class="tray-row-text">Where are we\?<\/span><span class="tray-key">⌘1</,
    );
    assert.match(html, /aria-label="Type: Commit \+ PR"/);
    assert.match(html, /aria-label="Edit saved prompts"/);
    assert.match(html, /<a class="tray-link" href="https:\/\/github.com\/acme\/app\/pull\/331"/);
    assert.match(html, /data-dot="green"/);
    assert.match(html, /checks green/);
    assert.match(html, />Ship the tray</);
    assert.match(html, /aria-label="Open in PhpStorm"/);
    assert.match(html, />62%</);
    assert.match(html, /zsh · 1h 12m · 125 msgs/);
    assert.match(html, /aria-label="Copy session id"/);
    assert.match(html, /aria-label="Archive"/);
    assert.match(html, /aria-label="Stop session"/);
});

test('a PR row shows the ⌘ key after the prompts’ that opens it; other links have none', () => {
    /* When */
    const html = tray();

    /* Then */
    assert.match(html, /checks green<span class="tray-key">⌘3<\/span>/);
    assert.equal(html.match(/<span class="tray-key">⌘3</g)?.length, 1);
    assert.doesNotMatch(html, /⌘4/);
});

test('a sent prompt’s row says Sent ✓', () => {
    /* When */
    const html = tray({sent: 'a'});

    /* Then */
    assert.match(html, /class="tray-row is-sent"[^>]*><span class="tray-row-text">Sent ✓</);
});

test('a remote session’s workspace buttons are disabled, a stopped session has no Stop, and Hand off… only shows with hosts', () => {
    /* When */
    const html = tray({editor: {available: false, reason: 'Not available for a remote session'}, running: false});

    /* Then */
    assert.match(html, /disabled=""[^>]*title="Not available for a remote session"[^>]*aria-label="Open in editor"/);
    assert.match(html, /disabled=""[^>]*aria-label="Stop session"|aria-label="Stop session"[^>]*disabled=""/);
    assert.doesNotMatch(html, /Hand off/);
});

test('with nothing saved or linked yet, the groups say so', () => {
    /* When */
    const html = tray({prompts: [], links: []});

    /* Then */
    assert.match(html, /No saved prompts yet/);
    assert.match(html, /Nothing yet/);
});

// ── What it says ──

test('context is a whole percentage, and unknown when nothing reported usage', () => {
    /* When */
    const values = [contextPercent(0.624), contextPercent(1.4), contextPercent(null)];

    /* Then */
    assert.deepEqual(values, [62, 100, null]);
});

test('running time reads in minutes, hours and days', () => {
    /* Given */
    const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

    /* When */
    const labels = [ago(12), ago(72), ago(60 * 27), null].map((at) => runningTimeLabel(at, NOW));

    /* Then */
    assert.deepEqual(labels, ['12m', '1h 12m', '1d 3h', null]);
});

test('the meta line leaves out what is unknown', () => {
    /* When */
    const line = sessionMetaLine({...stats, shell: null, messageCount: 1}, NOW);

    /* Then */
    assert.equal(line, '1h 12m · 1 msg');
});

test('a PR row says how it is doing, as the sidebar chip does', () => {
    /* When */
    const metas = [
        linkMeta(pr(1, {state: 'merged', checks: 'passing', dot: 'merged', mine: true}), NOW),
        linkMeta(pr(2, {state: 'open', checks: 'failing', dot: 'red', mine: true}), NOW),
        linkMeta(pr(3, null), NOW),
    ];

    /* Then */
    assert.deepEqual(metas, [
        {dot: 'merged', chip: '#1', text: 'merged'},
        {dot: 'red', chip: '#2', text: 'checks failing'},
        {dot: null, chip: '#3', text: ''},
    ]);
});

test("a Bugsnag error's row says bugsnag and its project", () => {
    /* When */
    const meta = linkMeta(
        {kind: 'bug', key: 'bug:u', title: 'ImageSourceNotReadyException', url: 'u', project: 'App', status: null},
        NOW,
    );

    /* Then */
    assert.deepEqual(meta, {dot: 'bug', chip: 'bugsnag', text: 'App'});
});

test('only the newest page is listed, and it opens only when this window still has it', () => {
    /* Given */
    const links = [page('new', NOW - 120_000), page('old', NOW - 600_000), task];

    /* When */
    const kept = trayLinks(links, {title: 'Page new', shownAt: NOW - 120_000});
    const lost = trayLinks(links, null);

    /* Then */
    assert.deepEqual(
        kept.map((row) => [row.link.key, row.opens]),
        [
            ['page:new', true],
            ['task:t1', true],
        ],
    );
    assert.deepEqual(
        lost.map((row) => [row.link.key, row.opens]),
        [
            ['page:new', false],
            ['task:t1', true],
        ],
    );
    assert.equal(linkMeta(links[0]!, NOW).text, '2m ago');
});

test('a page this window has but main has not read yet is listed before the task', () => {
    /* When */
    const rows = trayLinks([pr(5, null), task], {title: 'Fresh page', shownAt: NOW});

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.link.kind),
        ['pr', 'page', 'task'],
    );
});

test('a prompt is filled from the branch, the project, the task and the newest PR', () => {
    /* When */
    const facts = promptFacts({
        branch: 'feat/x',
        project: 'JBlaak/switchboard',
        task: null,
        links: [pr(9, null), pr(4, null), task],
    });

    /* Then */
    assert.deepEqual(facts, {
        branch: 'feat/x',
        project: 'JBlaak/switchboard',
        task: 'Ship the tray',
        pr: 'https://github.com/acme/app/pull/9',
    });
});

// ── The PRs' ⌘ keys ──

const keyed = (...keys: (number | null)[]): {key: number | null}[] => keys.map((key) => ({key}));

test('PRs are numbered on after the prompts’ keys, in list order, skipping other links', () => {
    /* Given */
    const links = [pr(12, null), task, pr(11, null)];

    /* When */
    const keys = pullRequestKeys(keyed(1, 2), links);

    /* Then */
    assert.deepEqual(
        [...keys],
        [
            ['pr:https://github.com/acme/app/pull/12', 3],
            ['pr:https://github.com/acme/app/pull/11', 4],
        ],
    );
});

test('without saved prompts the PRs start at ⌘1', () => {
    /* When */
    const keys = pullRequestKeys([], [pr(7, null)]);

    /* Then */
    assert.deepEqual([...keys.values()], [1]);
});

test('PRs past ⌘9 get no key, and nine prompts leave none for PRs', () => {
    /* Given */
    const links = [pr(1, null), pr(2, null), pr(3, null)];

    /* When */
    const afterEight = pullRequestKeys(keyed(1, 2, 3, 4, 5, 6, 7, 8), links);
    const afterNine = pullRequestKeys(keyed(1, 2, 3, 4, 5, 6, 7, 8, 9, null), links);

    /* Then */
    assert.deepEqual([...afterEight.values()], [9]);
    assert.equal(afterNine.size, 0);
});

test('a ⌘ key finds the PR numbered on it, and nothing on a prompt’s key or past the PRs', () => {
    /* Given */
    const prompts = keyed(1);
    const links = [pr(20, null), pr(19, null)];

    /* When */
    const second = pullRequestForKey(prompts, links, 3);
    const onPrompt = pullRequestForKey(prompts, links, 1);
    const past = pullRequestForKey(prompts, links, 4);

    /* Then */
    assert.equal(second?.number, 19);
    assert.equal(onPrompt, null);
    assert.equal(past, null);
});

// ── How fresh a PR's status is ──

const green = {state: 'open', checks: 'passing', dot: 'green', mine: true} as const;
const read = (fetchedAt: number | null, failed = false): SessionLink => ({
    ...(pr(7, green) as Extract<SessionLink, {kind: 'pr'}>),
    read: {fetchedAt, failed},
});

test("a PR's status read within two of gh's intervals says nothing in the tray", () => {
    /* Given */
    const link = read(NOW - 2 * LINKS_GITHUB_TTL_MS);

    /* When */
    const text = prFreshness(link, NOW, null);

    /* Then */
    assert.equal(text, null);
});

test("a PR's status older than two of gh's intervals says how old it is", () => {
    /* Given */
    const link = read(NOW - 5 * 60_000);

    /* When */
    const text = prFreshness(link, NOW, null);

    /* Then */
    assert.equal(text, 'Updated 5m ago');
});

test('a PR whose last read failed says so, even when it is recent', () => {
    /* Given */
    const link = read(NOW - 30_000, true);

    /* When */
    const text = prFreshness(link, NOW, null);

    /* Then */
    assert.match(text ?? '', /Couldn’t refresh$/);
});

test("a PR says GitHub's reads are paused while they are held back", () => {
    /* Given */
    const link = read(NOW - 30_000);
    const heldUntil = NOW + 10 * 60_000;

    /* When */
    const text = prFreshness(link, NOW, heldUntil);

    /* Then */
    assert.match(text ?? '', /Paused: GitHub budget low until/);
});

test('a PR without its own read, or another kind of link, says nothing about freshness', () => {
    /* Given */
    const links: SessionLink[] = [pr(7, green), task];

    /* When */
    const texts = links.map((link) => prFreshness(link, NOW, NOW + 60_000));

    /* Then */
    assert.deepEqual(texts, [null, null]);
});

test('the tray draws a stale PR status as a muted line under its link', () => {
    /* Given */
    const links = trayLinks([read(NOW - 5 * 60_000, true)], null);

    /* When */
    const html = tray({links});

    /* Then */
    assert.match(
        html,
        /<span class="tray-link-freshness" data-testid="tray-link-freshness">Updated 5m ago · Couldn’t refresh<\/span>/,
    );
});

test('the tray draws no freshness line for a fresh PR status', () => {
    /* Given */
    const links = trayLinks([read(NOW - 30_000)], null);

    /* When */
    const html = tray({links});

    /* Then */
    assert.doesNotMatch(html, /tray-link-freshness/);
});

// ── Make this a schedule ──

test('the tray offers Make this a schedule for a session that can be one', () => {
    /* When */
    const html = tray({makeSchedule: true});

    /* Then */
    assert.match(html, /<button type="button" class="tray-row"[^>]*aria-label="Make this a schedule"/);
});

test('the tray leaves Make this a schedule out for a session that cannot be one', () => {
    /* When */
    const html = tray({makeSchedule: false});

    /* Then */
    assert.doesNotMatch(html, /Make this a schedule/);
});

// ── Land it on a PR's status line ──

function landing(fields: {landing?: boolean; failure?: string | null} = {}): SessionTrayContentProps['land'] {
    return () => ({
        control: createElement('button', {type: 'button', className: 'land-it is-sm'}, 'Land it'),
        landing: fields.landing ?? false,
        failure: fields.failure ?? null,
    });
}

test("Land it sits on the PR's status line before its ⌘ key, outside the link", () => {
    /* When */
    const html = tray({land: landing()});

    /* Then */
    assert.match(
        html,
        /<div class="tray-link has-land"><a class="tray-link-title tray-link-cover" href="https:\/\/github.com\/acme\/app\/pull\/331"[^>]*>PR 331<\/a>/,
    );
    assert.match(
        html,
        /<span class="tray-link-status">[^<]*<\/span><span class="tray-land"><button type="button" class="land-it is-sm">Land it<\/button><\/span><span class="tray-key">⌘3<\/span>/,
    );
    assert.doesNotMatch(html, /<a [^>]*>(?:(?!<\/a>).)*<button/);
});

test('while it lands the status line says so, and a failed land says why under the PR', () => {
    /* When */
    const busy = tray({land: landing({landing: true})});
    const failed = tray({land: landing({failure: 'GitHub did not answer in time'})});

    /* Then */
    assert.match(busy, /<span class="tray-link-status">handing to the Merge manager…<\/span>/);
    assert.match(
        failed,
        /<span class="tray-land-failure" role="alert">Could not land: GitHub did not answer in time<\/span>/,
    );
});

test('before main answers, the tray lists the row’s PRs newest first, as the last answer had them where it did', () => {
    /* Given */
    const row = [
        {number: 40, url: 'https://github.com/acme/api/pull/40', repository: 'acme/api'},
        {number: 41, url: 'https://github.com/acme/api/pull/41', repository: 'acme/api'},
        {number: 40, url: 'https://github.com/acme/api/pull/40', repository: 'acme/api'},
    ];
    const known: LinkedPr[] = [
        {
            kind: 'pr',
            key: 'pr:https://github.com/acme/api/pull/40',
            title: 'Fix the login loop',
            url: 'https://github.com/acme/api/pull/40',
            repository: 'acme/api',
            number: 40,
            status: {state: 'open', checks: 'passing', dot: 'green', mine: true},
        },
    ];

    /* When */
    const prs = seededPullRequests(row, known);

    /* Then */
    assert.deepEqual(
        prs.map((pr) => [pr.key, pr.title, pr.status?.state ?? null]),
        [
            ['pr:https://github.com/acme/api/pull/41', 'acme/api#41', null],
            ['pr:https://github.com/acme/api/pull/40', 'Fix the login loop', 'open'],
        ],
    );
});

test('the Links group says it is loading while the links are asked for', () => {
    /* When */
    const loading = tray({links: [], linksLoading: true});
    const done = tray({links: []});

    /* Then */
    assert.match(loading, /tray-links-loading/);
    assert.match(loading, /Loading…/);
    assert.doesNotMatch(done, /tray-links-loading/);
    assert.match(done, /Nothing yet/);
});
