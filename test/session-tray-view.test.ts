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
    promptFacts,
    runningTimeLabel,
    sessionMetaLine,
    trayLinks,
} from '../src/renderer/ui/session-tray/tray-view';
import type {SessionLink} from '../src/domain/session/links';
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
