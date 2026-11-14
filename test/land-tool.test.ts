import {test} from 'node:test';
import assert from 'node:assert/strict';

import {LandToolService} from '../src/application/services/land-tool-service';
import {QUESTION_HOOK_TOKEN_HEADER} from '../src/domain/questions/question';
import {archiveToolReply} from '../src/domain/session/archive-tool';
import {LAND_TOOL_QUALIFIED_NAME, landOutcome, parseLandInput} from '../src/domain/merge-manager/land-tool';
import {QuestionHookServer} from '../src/infrastructure/http/question-hook-server';
import {silentLog} from './support/fakes';
import type {LandedView} from '../src/domain/merge-manager/model';
import type {LandResult} from '../src/application/services/merge-manager-service';

/**
 * A session landing its pull request: `land` on Switchboard's MCP server, and
 * the service that hands it to the Merge manager.
 */

const rpc = (method: string, params?: unknown, id = 1) => ({
    jsonrpc: '2.0',
    method,
    id,
    ...(params === undefined ? {} : {params}),
});

function landedView(place: number | null): LandedView {
    return {
        key: 'jblaak/switchboard#432',
        repository: 'JBlaak/switchboard',
        number: 432,
        title: 'Add land',
        url: 'https://github.com/JBlaak/switchboard/pull/432',
        headRef: 'land',
        lane: 'switchboard',
        landedAt: 0,
        stage: {kind: 'waiting', willConflict: false, position: null},
        setAside: null,
        errand: null,
        place,
    };
}

// ── The input ──

test('a pull request URL or owner/repo#number names the pull request', () => {
    /* When */
    const url = parseLandInput({pull_request: 'https://github.com/JBlaak/switchboard/pull/432'});
    const withTail = parseLandInput({pull_request: ' https://github.com/JBlaak/switchboard/pull/432/files '});
    const ref = parseLandInput({pull_request: 'JBlaak/switchboard#432'});

    /* Then */
    const expected = {ok: true, input: {repository: 'JBlaak/switchboard', number: 432}};
    assert.deepEqual(url, expected);
    assert.deepEqual(withTail, expected);
    assert.deepEqual(ref, expected);
});

test('anything else is refused, saying what to pass', () => {
    /* When */
    const missing = parseLandInput({});
    const bare = parseLandInput({pull_request: '432'});
    const issue = parseLandInput({pull_request: 'https://github.com/JBlaak/switchboard/issues/432'});
    const zero = parseLandInput({pull_request: 'JBlaak/switchboard#0'});

    /* Then */
    for (const parsed of [missing, bare, issue, zero]) {
        assert.equal(parsed.ok, false);
        assert.match(!parsed.ok ? parsed.error : '', /URL, or owner\/repo#number/);
    }
});

// ── What the session reads back ──

test('a landed pull request says its place in the lane', () => {
    /* When */
    const outcome = landOutcome({repository: 'JBlaak/switchboard', number: 432}, {ok: true, landed: landedView(2)});

    /* Then */
    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /^Landed #432 · 2nd in switchboard's lane \(JBlaak\/switchboard\)\./);
});

test('a refused pull request says why, as an error', () => {
    /* When */
    const outcome = landOutcome(
        {repository: 'JBlaak/switchboard', number: 432},
        {ok: false, reason: 'Mark it ready for review first'},
    );

    /* Then */
    assert.deepEqual(outcome, {
        ok: false,
        message: 'JBlaak/switchboard#432 did not land: Mark it ready for review first.',
    });
});

test('the service lands through the Merge manager', async () => {
    /* Given */
    const asked: unknown[] = [];
    const service = new LandToolService({
        mergeManager: {
            land: async (repository, number) => {
                asked.push([repository, number]);
                return {ok: true, landed: landedView(1)};
            },
        },
        log: silentLog,
    });

    /* When */
    const outcome = await service.land('s1', {repository: 'JBlaak/switchboard', number: 432});

    /* Then */
    assert.deepEqual(asked, [['JBlaak/switchboard', 432]]);
    assert.equal(outcome.ok, true);
});

// ── Over the hook server ──

async function landServer(land: (repository: string, number: number) => Promise<LandResult>) {
    const server = new QuestionHookServer({
        receiver: {receive: () => ({withdraw() {}}), turnEnded() {}, promptSubmitted() {}, subagentChanged() {}},
        archiveTool: {request: () => assert.fail('not the archive'), turnEnded() {}},
        landTool: new LandToolService({mergeManager: {land}, log: silentLog}),
        log: silentLog,
    });
    await server.start();
    const mcp = async (body: unknown) =>
        (
            await fetch(`${server.url}/mcp/s1`, {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {'Content-Type': 'application/json', [QUESTION_HOOK_TOKEN_HEADER]: server.token},
            })
        ).json() as Promise<any>;
    return {server, mcp};
}

test('a session lands its pull request over the socket, and reads where it landed', async (t) => {
    /* Given */
    const {server, mcp} = await landServer(async () => ({ok: true, landed: landedView(3)}));
    t.after(() => server.stop());

    /* When */
    const list = await mcp(rpc('tools/list'));
    const init = await mcp(rpc('initialize', {}));
    const call = await mcp(
        rpc('tools/call', {name: 'land', arguments: {pull_request: 'https://github.com/JBlaak/switchboard/pull/432'}}),
    );

    /* Then */
    assert.ok(list.result.tools.some((tool: {name: string}) => tool.name === 'land'));
    assert.match(init.result.instructions, new RegExp(LAND_TOOL_QUALIFIED_NAME));
    assert.equal(call.result.isError, false);
    assert.match(call.result.content[0].text, /^Landed #432 · 3rd in switchboard's lane/);
});

test('a land that fails comes back as an error the session can read', async (t) => {
    /* Given */
    const {server, mcp} = await landServer(async () => {
        throw new Error('gh is gone');
    });
    t.after(() => server.stop());

    /* When */
    const call = await mcp(rpc('tools/call', {name: 'land', arguments: {pull_request: 'JBlaak/switchboard#432'}}));

    /* Then */
    assert.deepEqual(call.result, {
        content: [{type: 'text', text: 'Switchboard could not finish land.'}],
        isError: true,
    });
});

test('without a land tool the server does not offer it', () => {
    /* When */
    const list = archiveToolReply(rpc('tools/list'), () => ({ok: true, message: ''})) as any;

    /* Then */
    assert.ok(!list.result.tools.some((tool: {name: string}) => tool.name === 'land'));
});
