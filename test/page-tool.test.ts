import {test} from 'node:test';
import assert from 'node:assert/strict';

import {ActiveSession} from '../src/application/model/active-session';
import {SessionRegistry} from '../src/application/model/session-registry';
import {PageToolService} from '../src/application/services/page-tool-service';
import {QUESTION_HOOK_TOKEN_HEADER} from '../src/domain/questions/question';
import {archiveToolReply} from '../src/domain/session/archive-tool';
import {
    PAGE_TOOL_QUALIFIED_NAME,
    pageTool,
    parsePageInput,
    READING_CSP,
    readingDocument,
} from '../src/domain/session/page-tool';
import {QuestionHookServer} from '../src/infrastructure/http/question-hook-server';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {openPage} from '../src/renderer/state/pages-slice';
import {fakePty, fakeRenderer, silentLog} from './support/fakes';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {ShownPage} from '../src/domain/session/page-tool';

/**
 * A session showing the user a page: `show_page` on Switchboard's MCP server,
 * the service that sends it to the window, and the window's pages slice.
 */

function newSession(): ActiveSession {
    return new ActiveSession({
        pty: fakePty(),
        projectPath: '/repo',
        projectFolder: '-repo',
        knownTranscriptIds: new Set(),
        sessionSlug: null,
        isPlainTerminal: false,
        remote: null,
        openedAt: 0,
    });
}

const rpc = (method: string, params?: unknown, id = 1) => ({
    jsonrpc: '2.0',
    method,
    id,
    ...(params === undefined ? {} : {params}),
});

const archiveNever = () => ({ok: false, message: 'not this one'});

// ── The input ──

test('a title and a body make a page, the title on one line', () => {
    /* When */
    const parsed = parsePageInput({title: '  General terms:\n  AI clauses ', html: '<p>Hi</p>'});

    /* Then */
    assert.deepEqual(parsed, {ok: true, page: {title: 'General terms: AI clauses', html: '<p>Hi</p>'}});
});

test('a page without a title or a body is refused, saying what is missing', () => {
    /* When */
    const noTitle = parsePageInput({html: '<p>Hi</p>'});
    const noBody = parsePageInput({title: 'T', html: '  '});
    const nothing = parsePageInput(undefined);

    /* Then */
    assert.equal(noTitle.ok, false);
    assert.match(!noTitle.ok ? noTitle.error : '', /title/);
    assert.equal(noBody.ok, false);
    assert.match(!noBody.ok ? noBody.error : '', /html/);
    assert.equal(nothing.ok, false);
});

test('a very long title is cut to fit the header', () => {
    /* When */
    const parsed = parsePageInput({title: 'x'.repeat(500), html: '<p>Hi</p>'});

    /* Then */
    assert.equal(parsed.ok && parsed.page.title.length, 200);
});

// ── The document ──

test('the document locks the page down and escapes the title', () => {
    /* When */
    const doc = readingDocument({title: '<b>"Terms"</b>', html: '<h2>Scope</h2><p>Text</p>'});

    /* Then */
    assert.ok(doc.includes(`content="${READING_CSP}"`));
    assert.match(READING_CSP, /default-src 'none'/);
    assert.doesNotMatch(READING_CSP, /script-src/);
    assert.ok(doc.includes('<title>&lt;b&gt;&quot;Terms&quot;&lt;/b&gt;</title>'));
    assert.ok(doc.includes('<article>\n<h2>Scope</h2><p>Text</p>\n</article>'));
});

// ── The protocol ──

test('the server lists show_page beside archive_session when it is offered', () => {
    /* When */
    const offered = archiveToolReply(rpc('tools/list'), archiveNever, [pageTool(() => ({ok: true, message: ''}))]);
    const alone = archiveToolReply(rpc('tools/list'), archiveNever);

    /* Then */
    const names = (reply: unknown) =>
        (reply as {result: {tools: {name: string}[]}}).result.tools.map((tool) => tool.name);
    assert.deepEqual(names(offered), ['archive_session', 'show_page']);
    assert.deepEqual(names(alone), ['archive_session']);
    assert.equal(PAGE_TOOL_QUALIFIED_NAME, 'mcp__switchboard__show_page');
});

test('the server tells the session when to show a page, but only when it offers the tool', () => {
    /* When */
    const offered = archiveToolReply(rpc('initialize', {}), archiveNever, [pageTool(() => ({ok: true, message: ''}))]);
    const alone = archiveToolReply(rpc('initialize', {}), archiveNever);

    /* Then */
    const instructions = (reply: unknown) => (reply as {result: {instructions?: string}}).result.instructions;
    assert.match(instructions(offered) ?? '', /make a text readable.*show_page/s);
    assert.equal(instructions(alone), undefined);
});

test('the page tool comes with a slash command that asks for the page', () => {
    /* Given */
    const tool = pageTool(() => ({ok: true, message: ''}));

    /* When */
    const init = archiveToolReply(rpc('initialize', {}), archiveNever, [tool]);
    const list = archiveToolReply(rpc('prompts/list'), archiveNever, [tool]);
    const got = archiveToolReply(rpc('prompts/get', {name: 'show_page'}), archiveNever, [tool]);

    /* Then */
    assert.deepEqual((init as {result: {capabilities: unknown}}).result.capabilities, {tools: {}, prompts: {}});
    const prompts = (list as {result: {prompts: {name: string; arguments: unknown[]}[]}}).result.prompts;
    assert.deepEqual(
        prompts.map((p) => [p.name, p.arguments]),
        [['show_page', []]],
    );
    const messages = (got as {result: {messages: {role: string; content: {text: string}}[]}}).result.messages;
    assert.equal(messages[0].role, 'user');
    assert.match(messages[0].content.text, /mcp__switchboard__show_page/);
});

test('without the page tool there are no prompts', () => {
    /* When */
    const init = archiveToolReply(rpc('initialize', {}), archiveNever);
    const got = archiveToolReply(rpc('prompts/get', {name: 'show_page'}), archiveNever);

    /* Then */
    assert.deepEqual((init as {result: {capabilities: unknown}}).result.capabilities, {tools: {}});
    assert.equal((got as {error: {code: number}}).error.code, -32602);
});

test('calling show_page shows the page and not the archive', () => {
    /* Given */
    const shown: unknown[] = [];
    let archived = false;
    const tool = pageTool((page) => {
        shown.push(page);
        return {ok: true, message: 'open'};
    });

    /* When */
    const reply = archiveToolReply(
        rpc('tools/call', {name: 'show_page', arguments: {title: 'T', html: '<p>x</p>'}}),
        () => {
            archived = true;
            return {ok: true, message: 'archived'};
        },
        [tool],
    );

    /* Then */
    assert.deepEqual(shown, [{title: 'T', html: '<p>x</p>'}]);
    assert.equal(archived, false);
    assert.deepEqual((reply as {result: unknown}).result, {content: [{type: 'text', text: 'open'}], isError: false});
});

test('a call with a bad page comes back as an error the session can read', () => {
    /* Given */
    const tool = pageTool(() => assert.fail('nothing to show'));

    /* When */
    const reply = archiveToolReply(rpc('tools/call', {name: 'show_page', arguments: {title: 'T'}}), archiveNever, [
        tool,
    ]);

    /* Then */
    const result = (reply as {result: {isError: boolean; content: {text: string}[]}}).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /html/);
});

// ── The service ──

function service(attached = true) {
    const registry = new SessionRegistry();
    const renderer = {...fakeRenderer(), attached};
    const recorded = fakeRenderer();
    renderer.pageShown = recorded.pageShown;
    const tool = new PageToolService({registry, renderer, clock: {now: () => 42}, log: silentLog});
    return {registry, recorded, tool};
}

test('a page goes to the window under the session’s current id', () => {
    /* Given */
    const {registry, recorded, tool} = service();
    const session = newSession();
    session.realSessionId = 'real-1';
    registry.add('launch-1', session);

    /* When */
    const outcome = tool.show('launch-1', {title: 'Terms', html: '<p>x</p>'});

    /* Then */
    assert.equal(outcome.ok, true);
    assert.deepEqual(recorded.only('pageShown'), [
        ['pageShown', {sessionId: 'real-1', title: 'Terms', html: '<p>x</p>', shownAt: 42}],
    ]);
});

test('a session Switchboard is not running shows nothing', () => {
    /* Given */
    const {recorded, tool} = service();

    /* When */
    const outcome = tool.show('ghost', {title: 'T', html: '<p>x</p>'});

    /* Then */
    assert.equal(outcome.ok, false);
    assert.deepEqual(recorded.only('pageShown'), []);
});

test('without a window the call says so', () => {
    /* Given */
    const {registry, recorded, tool} = service(false);
    registry.add('s1', newSession());

    /* When */
    const outcome = tool.show('s1', {title: 'T', html: '<p>x</p>'});

    /* Then */
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /window/);
    assert.deepEqual(recorded.only('pageShown'), []);
});

// ── Over the hook server ──

test('a session shows a page over the socket', async (t) => {
    /* Given */
    const registry = new SessionRegistry();
    const renderer = fakeRenderer();
    const server = new QuestionHookServer({
        receiver: {
            receive: () => ({withdraw() {}}),
            turnEnded: () => {},
            promptSubmitted: () => {},
            subagentChanged: () => {},
        },
        archiveTool: {request: archiveNever, turnEnded: () => {}},
        pageTool: new PageToolService({registry, renderer, clock: {now: () => 7}, log: silentLog}),
        log: silentLog,
    });
    await server.start();
    t.after(() => server.stop());
    registry.add('s1', newSession());

    /* When */
    const res = await fetch(`${server.url}/mcp/s1`, {
        method: 'POST',
        body: JSON.stringify(rpc('tools/call', {name: 'show_page', arguments: {title: 'T', html: '<p>x</p>'}})),
        headers: {'Content-Type': 'application/json', [QUESTION_HOOK_TOKEN_HEADER]: server.token},
    });

    /* Then */
    const body = (await res.json()) as {result: {isError: boolean}};
    assert.equal(body.result.isError, false);
    assert.deepEqual(renderer.only('pageShown'), [
        ['pageShown', {sessionId: 's1', title: 'T', html: '<p>x</p>', shownAt: 7}],
    ]);
});

// ── The window's pages ──

const shown = (sessionId: string, shownAt = 1): RendererEvent => ({
    type: 'pageShown',
    page: {sessionId, title: 'Terms', html: '<p>x</p>', shownAt} satisfies ShownPage,
});

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce(rootReducer, state);
}

test('a page arrives open over its session', () => {
    /* When */
    const state = run(initialRendererState(), shown('s1'));

    /* Then */
    assert.equal(openPage(state.pages, 's1')?.title, 'Terms');
    assert.equal(openPage(state.pages, 's2'), null);
});

test('closing a page puts it away, and the header brings it back', () => {
    /* Given */
    const state = run(initialRendererState(), shown('s1'));

    /* When */
    const closed = run(state, {type: 'pageClosed', sessionId: 's1'});
    /* Then */
    assert.equal(openPage(closed.pages, 's1'), null);
    assert.equal(closed.pages.bySession.s1?.open, false);

    /* When */
    const reopened = run(closed, {type: 'pageReopened', sessionId: 's1'});
    /* Then */
    assert.equal(openPage(reopened.pages, 's1')?.title, 'Terms');
});

test('a new page replaces the one put away, and opens', () => {
    /* Given */
    const state = run(initialRendererState(), shown('s1', 1), {type: 'pageClosed', sessionId: 's1'});

    /* When */
    const next = run(state, shown('s1', 2));

    /* Then */
    assert.equal(openPage(next.pages, 's1')?.shownAt, 2);
});

test('a page follows its session through a re-key, and goes when it is archived', () => {
    /* Given */
    const state = run(initialRendererState(), shown('old'));

    /* When */
    const forked = run(state, {type: 'sessionForked', oldId: 'old', newId: 'new'});
    /* Then */
    assert.equal(openPage(forked.pages, 'new')?.title, 'Terms');
    assert.equal(forked.pages.bySession.old, undefined);

    /* When */
    const archived = run(forked, {type: 'sessionArchived', sessionId: 'new'});
    /* Then */
    assert.deepEqual(archived.pages.bySession, {});
});

test('closing a session with no page changes nothing', () => {
    /* Given */
    const state = initialRendererState();

    /* When */
    const next = run(state, {type: 'pageClosed', sessionId: 's1'});

    /* Then */
    assert.equal(next, state);
});
